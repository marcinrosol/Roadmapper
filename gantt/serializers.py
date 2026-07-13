"""DRF serializers for the Gantt REST API models."""

from rest_framework import serializers

from .models import Task, TaskDependency, TaskMarker, TaskTransition


class TaskSerializer(serializers.ModelSerializer):
    """Serializes a Task. end_date is read-only because the model derives it
    from start_date/duration on save; assignee_name is a convenience
    read-only field so clients don't need a separate lookup for display."""

    assignee_name = serializers.CharField(
        source="assignee.username", read_only=True, default=None
    )

    class Meta:
        model = Task
        fields = [
            "id",
            "project",
            "parent",
            "name",
            "start_date",
            "end_date",
            "duration",
            "progress",
            "budget",
            "estimated_budget",
            "status",
            "task_type",
            "assignee",
            "assignee_name",
            "sort_order",
        ]
        read_only_fields = ["end_date"]


class TaskDependencySerializer(serializers.ModelSerializer):
    """Serializes a scheduling link between two tasks. Cycle prevention is
    enforced by the view/validator layer, not here."""

    class Meta:
        model = TaskDependency
        fields = ["id", "project", "predecessor", "successor", "link_type", "lag"]


class TaskTransitionSerializer(serializers.ModelSerializer):
    """Serializes a purely visual, potentially cross-project arrow between
    two tasks."""

    class Meta:
        model = TaskTransition
        fields = ["id", "project", "from_task", "to_task", "on_date"]


class TaskMarkerSerializer(serializers.ModelSerializer):
    """Serializes a milestone/key-event/decision-point marker on a task."""

    class Meta:
        model = TaskMarker
        fields = ["id", "project", "task", "marker_type", "on_date", "description"]
