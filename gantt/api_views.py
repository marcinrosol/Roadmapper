"""DRF viewsets for the Gantt REST API: tasks, dependency links, transitions,
and markers, all scoped to projects the requesting user can edit."""

from django.db.models import Q
from rest_framework import viewsets
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated

from projects.models import Project
from projects.permissions import user_can_edit_project

from .models import Task, TaskDependency, TaskMarker, TaskTransition
from .serializers import (
    TaskDependencySerializer,
    TaskMarkerSerializer,
    TaskSerializer,
    TaskTransitionSerializer,
)
from .validators import validate_link, validate_transition


class IsProjectMember(IsAuthenticated):
    """Object-level permission: authenticated, and can edit the object's project."""

    def has_object_permission(self, request, view, obj):
        return user_can_edit_project(request.user, obj.project)


class ProjectScopedMixin:
    """Shared plumbing for all Gantt viewsets: restricts the queryset to
    objects belonging to projects the user owns or is a member of, and
    provides a helper to resolve+authorize a project id from request data."""

    permission_classes = [IsProjectMember]

    def _get_project(self, project_id):
        try:
            project = Project.objects.get(pk=project_id)
        except (Project.DoesNotExist, TypeError, ValueError):
            raise PermissionDenied("Unknown project.")
        if not user_can_edit_project(self.request.user, project):
            raise PermissionDenied("You are not a member of this project.")
        return project

    def get_queryset(self):
        qs = super().get_queryset()
        user = self.request.user
        return qs.filter(
            Q(project__owner=user) | Q(project__memberships__user=user)
        ).distinct()


class TaskViewSet(ProjectScopedMixin, viewsets.ModelViewSet):
    """CRUD for tasks. The project is taken from request data on create and
    re-validated (in case the client tries to move a task to a project the
    user can't edit) on update."""

    queryset = Task.objects.all()
    serializer_class = TaskSerializer

    def perform_create(self, serializer):
        project = self._get_project(self.request.data.get("project"))
        serializer.save(project=project)

    def perform_update(self, serializer):
        project = serializer.instance.project
        self._get_project(project.pk)
        serializer.save()


class TaskLinkViewSet(ProjectScopedMixin, viewsets.ModelViewSet):
    """CRUD for task dependency links, with cycle-prevention validation on
    every create/update via validate_link."""

    queryset = TaskDependency.objects.all()
    serializer_class = TaskDependencySerializer

    def perform_create(self, serializer):
        project = self._get_project(self.request.data.get("project"))
        predecessor = serializer.validated_data["predecessor"]
        successor = serializer.validated_data["successor"]
        validate_link(predecessor, successor, project)
        serializer.save(project=project)

    def perform_update(self, serializer):
        project = serializer.instance.project
        self._get_project(project.pk)
        predecessor = serializer.validated_data.get(
            "predecessor", serializer.instance.predecessor
        )
        successor = serializer.validated_data.get(
            "successor", serializer.instance.successor
        )
        # Exclude this link's own row from the cycle check, otherwise an
        # unrelated edit (e.g. changing lag) on an existing link would count
        # itself as part of the graph and could self-report as a cycle.
        validate_link(
            predecessor, successor, project, exclude_link_id=serializer.instance.pk
        )
        serializer.save()


class TaskTransitionViewSet(ProjectScopedMixin, viewsets.ModelViewSet):
    """Purely visual arrows between tasks — no cycle detection or scheduling impact."""

    queryset = TaskTransition.objects.all()
    serializer_class = TaskTransitionSerializer

    def perform_create(self, serializer):
        project = self._get_project(self.request.data.get("project"))
        from_task = serializer.validated_data["from_task"]
        to_task = serializer.validated_data["to_task"]
        validate_transition(from_task, to_task, project, self.request.user)
        serializer.save(project=project)

    def perform_update(self, serializer):
        project = serializer.instance.project
        self._get_project(project.pk)
        from_task = serializer.validated_data.get(
            "from_task", serializer.instance.from_task
        )
        to_task = serializer.validated_data.get("to_task", serializer.instance.to_task)
        validate_transition(from_task, to_task, project, self.request.user)
        serializer.save()


class TaskMarkerViewSet(ProjectScopedMixin, viewsets.ModelViewSet):
    """Milestones / key events / decision points attached to a task."""

    queryset = TaskMarker.objects.all()
    serializer_class = TaskMarkerSerializer

    def perform_create(self, serializer):
        project = self._get_project(self.request.data.get("project"))
        serializer.save(project=project)

    def perform_update(self, serializer):
        project = serializer.instance.project
        self._get_project(project.pk)
        serializer.save()
