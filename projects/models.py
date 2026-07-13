"""Domain models for the projects app: a Project (the top-level container that
gantt tasks belong to) and ProjectMembership (the join table that grants a
user access to a project)."""

from django.conf import settings
from django.db import models
from django.db.models import Sum
from django.urls import reverse


class Project(models.Model):
    """A roadmap/gantt project. Owns tasks (see gantt.models.Task) and has an
    owner plus zero or more members (via ProjectMembership) who may view or
    edit it. Budget is not stored directly but rolled up from tasks."""

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        ON_HOLD = "on_hold", "On hold"
        COMPLETED = "completed", "Completed"
        ARCHIVED = "archived", "Archived"

    name = models.CharField(max_length=200)
    description = models.TextField(blank=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="owned_projects",
    )
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL,
        through="ProjectMembership",
        related_name="projects",
    )
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.ACTIVE
    )
    color = models.CharField(max_length=7, default="#3C6E9E", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("projects:board") + f"?project={self.pk}"

    @property
    def budget(self):
        """Sum of leaf tasks' budgets — summary/parent tasks are excluded so their
        (unused) own budget value doesn't double-count what their subtasks total."""
        total = self.tasks.filter(children__isnull=True).aggregate(total=Sum("budget"))[
            "total"
        ]
        return total or 0


class ProjectMembership(models.Model):
    """Grants a user access to a project with a given role. Existence of a
    membership row (or being the owner) is what user_can_view_project/
    user_can_edit_project in permissions.py check for."""

    class Role(models.TextChoices):
        MEMBER = "member", "Member"
        VIEWER = "viewer", "Viewer"

    project = models.ForeignKey(
        Project, on_delete=models.CASCADE, related_name="memberships"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="project_memberships",
    )
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.MEMBER)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"], name="unique_project_membership"
            )
        ]

    def __str__(self):
        return f"{self.user} on {self.project} ({self.role})"
