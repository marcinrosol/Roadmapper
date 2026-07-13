"""DRF REST API for Project records (used by external/API clients; the main
board UI talks to the plain JSON endpoints in projects.views instead)."""

from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from .models import Project
from .permissions import user_can_edit_project
from .serializers import ProjectBoardSerializer
from .views import _visible_projects


class IsProjectMemberObj(IsAuthenticated):
    """Requires authentication, and for object-level actions (retrieve,
    update, delete) requires the user to be the project's owner or a member."""

    def has_object_permission(self, request, view, obj):
        return user_can_edit_project(request.user, obj)


class ProjectViewSet(viewsets.ModelViewSet):
    """CRUD API for projects, scoped to the projects the requesting user can
    see (owned or member-of)."""

    serializer_class = ProjectBoardSerializer
    permission_classes = [IsProjectMemberObj]

    def get_queryset(self):
        return _visible_projects(self.request.user)

    def perform_create(self, serializer):
        # Owner is always the creating user, not a client-supplied value.
        serializer.save(owner=self.request.user)
