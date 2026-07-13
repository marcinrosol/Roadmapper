"""Server-rendered views for the project board, portfolio import/export, and
per-project settings/membership management."""

import json

from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.db.models import Q, Sum
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.views.decorators.http import require_POST

from gantt.exports import build_board_export, import_board_data, write_tasks_csv
from gantt.models import Task, TaskDependency, TaskMarker, TaskTransition
from gantt.serializers import (
    TaskDependencySerializer,
    TaskMarkerSerializer,
    TaskSerializer,
    TaskTransitionSerializer,
)

from .forms import MemberAddForm, ProjectForm
from .models import Project, ProjectMembership
from .permissions import user_can_edit_project
from .serializers import ProjectBoardSerializer

User = get_user_model()


def _visible_projects(user):
    """Projects the user owns or is a member of. distinct() is required
    because the membership join can otherwise duplicate a project row per
    membership match."""
    return Project.objects.filter(Q(owner=user) | Q(memberships__user=user)).distinct()


@login_required
def board(request):
    return render(request, "projects/board.html", {})


@login_required
def board_data(request):
    """JSON payload backing the gantt board UI: every project the user can
    see, plus their tasks, dependency links, transitions, and markers, in
    the shape the frontend expects."""
    projects = _visible_projects(request.user).select_related("owner")
    tasks = (
        Task.objects.filter(project__in=projects).select_related("assignee")
        # sort_order (with id as a tiebreaker) matches the manual ordering
        # users set by dragging rows on the board; the frontend relies on
        # this ordering rather than re-sorting client-side.
        .order_by("sort_order", "id")
    )
    links = TaskDependency.objects.filter(project__in=projects)
    transitions = TaskTransition.objects.filter(project__in=projects)
    markers = TaskMarker.objects.filter(project__in=projects)
    return JsonResponse(
        {
            "projects": ProjectBoardSerializer(projects, many=True).data,
            "tasks": TaskSerializer(tasks, many=True).data,
            "links": TaskDependencySerializer(links, many=True).data,
            "transitions": TaskTransitionSerializer(transitions, many=True).data,
            "markers": TaskMarkerSerializer(markers, many=True).data,
            # One membership query per project (not prefetched) — acceptable
            # given the small number of projects a user typically sees.
            "can_edit": {
                p.pk: user_can_edit_project(request.user, p) for p in projects
            },
            "current_user_id": request.user.id,
        }
    )


@login_required
def portfolio_export_csv(request):
    """Download all tasks across every project the user can see as a single
    CSV (used for the "export portfolio" action, as opposed to a per-project
    export)."""
    projects = _visible_projects(request.user)
    tasks = (
        Task.objects.filter(project__in=projects)
        .select_related("project", "parent", "assignee")
        .prefetch_related("predecessor_links__predecessor", "markers")
        .order_by("project__name", "sort_order", "id")
    )
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = 'attachment; filename="portfolio-tasks.csv"'
    write_tasks_csv(response, tasks, include_project=True)
    return response


@login_required
def portfolio_export_json(request):
    """Download the full board state (projects, tasks, links, etc.) as JSON,
    in the same shape board_import expects, for backup/re-import."""
    projects = _visible_projects(request.user)
    data = build_board_export(projects)
    response = HttpResponse(json.dumps(data, indent=2), content_type="application/json")
    response["Content-Disposition"] = 'attachment; filename="portfolio-board.json"'
    return response


@login_required
@require_POST
def board_import(request):
    """Restore/merge board data previously produced by portfolio_export_json.
    Validation of the payload's structure and permissions happens inside
    import_board_data; both JSON parsing and payload errors are reported as
    400s rather than 500s since they represent bad user input."""
    try:
        payload = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": "That file isn't valid JSON."}, status=400)
    try:
        summary = import_board_data(request.user, payload)
    except ValueError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    return JsonResponse(summary)


def _get_editable_project_or_404(request, pk):
    # 404 (not 403) for both "doesn't exist" and "exists but no access" so a
    # non-member can't infer a project's existence from the response.
    project = get_object_or_404(Project, pk=pk)
    if not user_can_edit_project(request.user, project):
        raise Http404
    return project


@login_required
def project_settings(request, pk):
    """View/edit a project's settings and list its members. Also serves as
    the page the member-management partials (below) are embedded in."""
    project = _get_editable_project_or_404(request, pk)

    if request.method == "POST":
        form = ProjectForm(request.POST, instance=project)
        if form.is_valid():
            form.save()
            messages.success(request, "Project updated.")
            return redirect("projects:settings", pk=project.pk)
    else:
        form = ProjectForm(instance=project)

    return render(
        request,
        "projects/settings.html",
        {
            "project": project,
            "form": form,
            "members": project.memberships.select_related("user"),
        },
    )


@login_required
def member_list_partial(request, pk):
    project = _get_editable_project_or_404(request, pk)
    return render(
        request,
        "projects/_member_list.html",
        {"project": project, "members": project.memberships.select_related("user")},
    )


@login_required
def member_add(request, pk):
    """Add a member by username. Renders the same member-list partial back
    (with no change) if the form is invalid, rather than surfacing errors,
    since this is called from an inline form via HTMX/fetch."""
    project = _get_editable_project_or_404(request, pk)

    form = MemberAddForm(request.POST)
    if form.is_valid():
        user = User.objects.get(username=form.cleaned_data["username"])
        # get_or_create makes re-adding an existing member a harmless no-op.
        ProjectMembership.objects.get_or_create(project=project, user=user)

    return render(
        request,
        "projects/_member_list.html",
        {"project": project, "members": project.memberships.select_related("user")},
    )


@login_required
def member_remove(request, pk, uid):
    project = _get_editable_project_or_404(request, pk)

    ProjectMembership.objects.filter(project=project, user_id=uid).delete()

    return render(
        request,
        "projects/_member_list.html",
        {"project": project, "members": project.memberships.select_related("user")},
    )
