"""Validation rules for task dependency links and task transitions, kept
separate from the models so both the API views and the serializers can
share the same checks."""

from rest_framework import serializers

from projects.permissions import user_can_edit_project

from .models import TaskDependency


def would_create_cycle(predecessor_id, successor_id, project_id, exclude_link_id=None):
    """Returns True if adding predecessor -> successor would close a cycle,
    by checking whether predecessor is reachable by walking forward from
    successor through existing links in the same project."""
    if predecessor_id == successor_id:
        # A task can't depend on itself; treat as a (trivial) cycle.
        return True

    links = TaskDependency.objects.filter(project_id=project_id)
    if exclude_link_id is not None:
        # When validating an edit to an existing link, exclude that link's
        # own row so it doesn't count itself as part of the graph.
        links = links.exclude(pk=exclude_link_id)

    graph = {}
    for link in links.values("predecessor_id", "successor_id"):
        graph.setdefault(link["predecessor_id"], []).append(link["successor_id"])

    # Depth-first search forward from successor: if we can reach predecessor,
    # then adding predecessor -> successor would close a loop.
    stack = [successor_id]
    visited = set()
    while stack:
        node = stack.pop()
        if node == predecessor_id:
            return True
        if node in visited:
            continue
        visited.add(node)
        stack.extend(graph.get(node, []))

    return False


def validate_link(predecessor, successor, project, exclude_link_id=None):
    """Raises ValidationError unless predecessor and successor both belong to
    the given project and the link would not introduce a dependency cycle."""
    if predecessor.project_id != project.pk or successor.project_id != project.pk:
        raise serializers.ValidationError(
            "Both tasks must belong to the same project as the link."
        )
    if would_create_cycle(predecessor.pk, successor.pk, project.pk, exclude_link_id):
        raise serializers.ValidationError(
            "This link would create a circular dependency."
        )


def validate_transition(from_task, to_task, project, user):
    """Transitions are purely visual and, unlike dependencies, may point across
    projects — but the source task must belong to the transition's own project,
    and the user must have edit access to whichever project owns the target task."""
    if from_task.project_id != project.pk:
        raise serializers.ValidationError(
            "The source task must belong to the transition's project."
        )
    if not user_can_edit_project(user, to_task.project):
        raise serializers.ValidationError(
            "You don't have edit access to the target task's project."
        )
