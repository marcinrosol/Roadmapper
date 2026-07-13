"""Access-control helpers shared by the projects views, API views, and gantt
app. There is currently no distinction between "view" and "edit" access —
any owner or member can edit — but the two functions are kept separate so
that a future read-only role doesn't require touching every call site."""

from django.contrib.auth import get_user_model
from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Q
from django.http import Http404
from django.shortcuts import get_object_or_404

from .models import Project

User = get_user_model()


def user_can_view_project(user, project):
    """True if the user is the project's owner or has any membership on it."""
    return project.owner_id == user.id or project.memberships.filter(user=user).exists()


def user_can_edit_project(user, project):
    return user_can_view_project(user, project)


def project_assignable_users(project):
    """Users eligible to be assigned to tasks on this project: its owner
    plus everyone with a membership."""
    return User.objects.filter(
        Q(pk=project.owner_id) | Q(project_memberships__project=project)
    ).distinct()


class ProjectAccessMixin(LoginRequiredMixin):
    """CBV mixin: loads self.project from the pk/project_id URL kwarg and 404s
    (rather than 403s, to avoid confirming a project's existence to non-members)
    if the requesting user isn't the owner or a member."""

    project_url_kwarg = "pk"

    def dispatch(self, request, *args, **kwargs):
        # Defer to LoginRequiredMixin's redirect for anonymous users instead
        # of querying for the project first.
        if not request.user.is_authenticated:
            return super().dispatch(request, *args, **kwargs)
        self.project = get_object_or_404(Project, pk=kwargs[self.project_url_kwarg])
        if not user_can_view_project(request.user, self.project):
            raise Http404
        return super().dispatch(request, *args, **kwargs)
