"""HTML/export views for the Gantt app: a legacy project-detail redirect and
CSV/JSON export endpoints for a single project's tasks and links."""

import json

from django.contrib.auth.decorators import login_required
from django.http import Http404, HttpResponse, HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils.text import slugify

from projects.models import Project
from projects.permissions import user_can_view_project

from .exports import build_board_export, write_tasks_csv
from .models import Task


def _get_visible_project_or_404(request, pk):
    """Fetch a project by pk, raising 404 both when it doesn't exist and when
    the user lacks view access (so existence isn't leaked to non-viewers)."""
    project = get_object_or_404(Project, pk=pk)
    if not user_can_view_project(request.user, project):
        raise Http404
    return project


@login_required
def project_detail(request, pk):
    """Legacy URL kept for old bookmarks/links; the Gantt page is now the unified board."""
    project = _get_visible_project_or_404(request, pk)
    return HttpResponseRedirect(reverse("projects:board") + f"?project={project.pk}")


@login_required
def export_tasks_csv(request, pk):
    """Download a single project's tasks as a CSV file."""
    project = _get_visible_project_or_404(request, pk)
    tasks = (
        Task.objects.filter(project=project)
        .select_related("parent", "assignee")
        .prefetch_related("predecessor_links__predecessor", "markers")
        .order_by("sort_order", "id")
    )
    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = (
        f'attachment; filename="{slugify(project.name)}-tasks.csv"'
    )
    write_tasks_csv(response, tasks, include_project=False)
    return response


@login_required
def export_project_json(request, pk):
    """Download a single project as a full-fidelity JSON board export, the
    same format produced/consumed for multi-project board export/import."""
    project = _get_visible_project_or_404(request, pk)
    data = build_board_export([project])
    response = HttpResponse(json.dumps(data, indent=2), content_type="application/json")
    response["Content-Disposition"] = (
        f'attachment; filename="{slugify(project.name)}-board.json"'
    )
    return response
