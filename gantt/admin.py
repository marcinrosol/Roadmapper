"""Django admin registrations for the Gantt models."""

from django.contrib import admin

from .models import Task, TaskDependency, TaskMarker, TaskTransition


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    """Admin list view for tasks, including hierarchy and budget fields."""

    list_display = (
        "name",
        "project",
        "parent",
        "start_date",
        "end_date",
        "duration",
        "progress",
        "budget",
        "estimated_budget",
        "status",
        "task_type",
        "assignee",
    )
    list_filter = ("project", "status", "task_type")
    search_fields = ("name",)


@admin.register(TaskDependency)
class TaskDependencyAdmin(admin.ModelAdmin):
    """Admin list view for predecessor/successor scheduling links."""

    list_display = ("project", "predecessor", "successor", "link_type", "lag")
    list_filter = ("project", "link_type")


@admin.register(TaskTransition)
class TaskTransitionAdmin(admin.ModelAdmin):
    """Admin list view for visual (non-scheduling) task-to-task arrows."""

    list_display = ("project", "from_task", "to_task", "on_date")
    list_filter = ("project",)


@admin.register(TaskMarker)
class TaskMarkerAdmin(admin.ModelAdmin):
    """Admin list view for milestone/key-event/decision-point markers."""

    list_display = ("project", "task", "marker_type", "on_date", "description")
    list_filter = ("project", "marker_type")
