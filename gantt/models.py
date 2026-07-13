"""Domain models for the Gantt app: hierarchical tasks, the dependency links
that drive scheduling between them, purely visual transitions between tasks,
and point-in-time markers (milestones/key events/decision points)."""

import datetime

from django.conf import settings
from django.db import models

from projects.models import Project


class Task(models.Model):
    """A schedulable unit of work within a project. Tasks form a tree via
    ``parent``/``children``: a task with ``task_type == PROJECT`` is a summary
    row grouping its children, while a plain ``TASK`` is a leaf of actual work.
    ``end_date`` is not user-editable; it is always derived from ``start_date``
    and ``duration`` on save."""

    class TaskType(models.TextChoices):
        TASK = "task", "Task"
        PROJECT = "project", "Summary"

    class Status(models.TextChoices):
        ON_TRACK = "on_track", "On track"
        AT_RISK = "at_risk", "At risk"
        COMPLETE = "complete", "Complete"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    parent = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="children",
    )
    name = models.CharField(max_length=255)
    start_date = models.DateField()
    duration = models.PositiveIntegerField(default=1, help_text="Duration in days")
    end_date = models.DateField(editable=False)
    progress = models.FloatField(default=0.0)
    budget = models.DecimalField(max_digits=12, decimal_places=2, default=0, blank=True)
    estimated_budget = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=0,
        blank=True,
        help_text="Placeholder/ballpark budget, independent of the actual budget above.",
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ON_TRACK
    )
    task_type = models.CharField(
        max_length=20, choices=TaskType.choices, default=TaskType.TASK
    )
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="assigned_tasks",
    )
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "id"]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        """Recompute end_date from start_date + duration on every save, so it
        never drifts out of sync with the fields that define it. duration is
        clamped to non-negative to avoid an end_date before start_date."""
        self.end_date = self.start_date + datetime.timedelta(days=max(self.duration, 0))
        super().save(*args, **kwargs)


class TaskDependency(models.Model):
    """A scheduling link between two tasks in the same project (predecessor ->
    successor). link_type and lag together determine how the successor's
    dates constrain relative to the predecessor's; cycle prevention for these
    links is enforced at the validator/serializer level, not here."""

    class LinkType(models.TextChoices):
        FINISH_TO_START = "finish_to_start", "Finish to start"
        START_TO_START = "start_to_start", "Start to start"
        FINISH_TO_FINISH = "finish_to_finish", "Finish to finish"
        START_TO_FINISH = "start_to_finish", "Start to finish"

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="task_dependencies"
    )
    predecessor = models.ForeignKey(
        Task, on_delete=models.CASCADE, related_name="successor_links"
    )
    successor = models.ForeignKey(
        Task, on_delete=models.CASCADE, related_name="predecessor_links"
    )
    link_type = models.CharField(
        max_length=20, choices=LinkType.choices, default=LinkType.FINISH_TO_START
    )
    lag = models.IntegerField(default=0, help_text="Lag/lead in days")

    class Meta:
        verbose_name_plural = "Task dependencies"
        constraints = [
            models.UniqueConstraint(
                fields=["predecessor", "successor", "link_type"],
                name="unique_task_link",
            )
        ]

    def __str__(self):
        return (
            f"{self.predecessor} -> {self.successor} ({self.get_link_type_display()})"
        )


class TaskTransition(models.Model):
    """A purely visual arrow from one task to another, both anchored at the same
    date. Unlike TaskDependency, this does not drive scheduling and is not subject to
    cycle detection or critical-path calculation."""

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="task_transitions"
    )
    from_task = models.ForeignKey(
        Task, on_delete=models.CASCADE, related_name="transitions_from"
    )
    to_task = models.ForeignKey(
        Task, on_delete=models.CASCADE, related_name="transitions_to"
    )
    on_date = models.DateField()

    class Meta:
        verbose_name_plural = "Task transitions"

    def __str__(self):
        return f"{self.from_task} -> {self.to_task} ({self.on_date})"


class TaskMarker(models.Model):
    """A milestone, key event, or decision point attached to an existing task and
    anchored at a specific date. Rendered as a large indicator on top of that
    task's bar, distinct from the task's own start/end dates."""

    class MarkerType(models.TextChoices):
        MILESTONE = "milestone", "Milestone"
        KEY_EVENT = "key_event", "Key event"
        DECISION_POINT = "decision_point", "Decision point"

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="task_markers"
    )
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="markers")
    marker_type = models.CharField(max_length=20, choices=MarkerType.choices)
    on_date = models.DateField()
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["on_date"]

    def __str__(self):
        return f"{self.get_marker_type_display()} on {self.task} ({self.on_date})"
