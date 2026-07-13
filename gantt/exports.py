"""CSV/JSON export of a project's tasks and links, plus import of the JSON
"board export" format back into projects (used for both single-project
download/upload and full multi-project board backups)."""

import csv
import datetime
from decimal import Decimal, InvalidOperation

from django.contrib.auth import get_user_model
from django.db import transaction

from projects.models import Project
from projects.permissions import user_can_edit_project

from .models import Task, TaskDependency, TaskMarker, TaskTransition

User = get_user_model()

BOARD_EXPORT_FORMAT = "roadmapper-board-export"
BOARD_EXPORT_VERSION = 1

CSV_HEADERS = [
    "Project",
    "Task",
    "Parent Task",
    "Owner",
    "Start",
    "End",
    "Status",
    "Progress %",
    "Budget",
    "Estimated Budget",
    "Markers",
    "Depends On",
]


def _task_row(task, include_project):
    """Build one CSV row for a task, joining its predecessors and markers
    into semicolon-separated display strings."""
    depends_on = "; ".join(
        link.predecessor.name for link in task.predecessor_links.all()
    )
    markers = "; ".join(
        m.get_marker_type_display() + (f" ({m.description})" if m.description else "")
        for m in task.markers.all()
    )
    row = [
        task.name,
        task.parent.name if task.parent_id else "",
        task.assignee.username if task.assignee_id else "",
        task.start_date.isoformat(),
        task.end_date.isoformat(),
        task.get_status_display(),
        round((task.progress or 0) * 100),
        str(task.budget),
        str(task.estimated_budget),
        markers,
        depends_on,
    ]
    if include_project:
        row.insert(0, task.project.name)
    return row


def write_tasks_csv(response, tasks, include_project=True):
    """Write tasks as CSV rows to a file-like response, e.g. an HttpResponse."""
    writer = csv.writer(response)
    writer.writerow(CSV_HEADERS if include_project else CSV_HEADERS[1:])
    for task in tasks:
        writer.writerow(_task_row(task, include_project))


def build_project_export(project):
    """Full-fidelity JSON-serializable snapshot of a project: metadata, tasks
    (hierarchy via parent id), dependencies, and transitions. Task/link ids in
    this structure are the *original* database ids, used only as reference keys
    for parent/predecessor/successor/from_task/to_task — import_board_data remaps
    them to new rows rather than reusing the ids directly."""
    tasks = project.tasks.all().select_related("assignee")
    deps = project.task_dependencies.all()
    transitions = project.task_transitions.all()
    markers = project.task_markers.all()
    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "status": project.status,
        "budget": str(project.budget),
        "color": project.color,
        "tasks": [
            {
                "id": t.id,
                "name": t.name,
                "parent": t.parent_id,
                "start_date": t.start_date.isoformat(),
                "duration": t.duration,
                "progress": t.progress,
                "budget": str(t.budget),
                "estimated_budget": str(t.estimated_budget),
                "status": t.status,
                "task_type": t.task_type,
                "assignee_username": t.assignee.username if t.assignee_id else None,
                "sort_order": t.sort_order,
            }
            for t in tasks
        ],
        "dependencies": [
            {
                "predecessor": d.predecessor_id,
                "successor": d.successor_id,
                "link_type": d.link_type,
                "lag": d.lag,
            }
            for d in deps
        ],
        "transitions": [
            {
                "from_task": tr.from_task_id,
                "to_task": tr.to_task_id,
                "on_date": tr.on_date.isoformat(),
            }
            for tr in transitions
        ],
        "markers": [
            {
                "task": m.task_id,
                "marker_type": m.marker_type,
                "on_date": m.on_date.isoformat(),
                "description": m.description,
            }
            for m in markers
        ],
    }


def build_board_export(projects):
    """Wrap one or more project exports in the versioned board-export envelope
    used to identify and validate files on import."""
    return {
        "format": BOARD_EXPORT_FORMAT,
        "version": BOARD_EXPORT_VERSION,
        "projects": [build_project_export(p) for p in projects],
    }


def import_board_data(user, data):
    """Import a board export dict for the given user. Each project entry either
    updates an existing project in place (full replace of its tasks/dependencies/
    transitions) if its "id" matches a project the user can edit, or creates a new
    project owned by the importing user otherwise. Raises ValueError on malformed
    input. The whole import is atomic: any error rolls back everything."""
    if not isinstance(data, dict) or data.get("format") != BOARD_EXPORT_FORMAT:
        raise ValueError("Unrecognized file format.")
    projects_data = data.get("projects")
    if not isinstance(projects_data, list) or not projects_data:
        raise ValueError("Malformed file: expected a non-empty 'projects' list.")

    summary = {"created": [], "updated": [], "warnings": []}
    with transaction.atomic():
        for pdata in projects_data:
            if not isinstance(pdata, dict):
                raise ValueError(
                    "Malformed file: each project entry must be an object."
                )
            entry = _import_one_project(user, pdata)
            summary["created" if entry["action"] == "created" else "updated"].append(
                entry["name"]
            )
            summary["warnings"].extend(entry["warnings"])
    return summary


def _import_one_project(user, pdata):
    """Create-or-update a single project from its export dict, remapping the
    original task ids in pdata to newly created rows via id_map so parent
    links, dependencies, transitions, and markers can be reattached correctly.
    Skips (with a warning) any reference to a task id that failed to import,
    rather than aborting the whole project."""
    warnings = []
    project = None
    project_id = pdata.get("id")
    if project_id:
        candidate = Project.objects.filter(pk=project_id).first()
        if candidate is not None and user_can_edit_project(user, candidate):
            project = candidate

    action = "updated" if project else "created"
    if project is None:
        project = Project(owner=user)

    project.name = pdata.get("name") or (
        project.name if project.pk else "Imported project"
    )
    project.description = pdata.get(
        "description", project.description if project.pk else ""
    )
    project.status = pdata.get("status") or (
        project.status if project.pk else Project.Status.ACTIVE
    )
    project.color = pdata.get("color") or project.color or "#3C6E9E"
    project.save()

    # Full replace: cascades to this project's dependencies/transitions too.
    project.tasks.all().delete()

    id_map = {}
    for tdata in pdata.get("tasks", []):
        assignee = None
        username = tdata.get("assignee_username")
        if username:
            assignee = User.objects.filter(username=username).first()
            if assignee is None:
                warnings.append(
                    f"Assignee '{username}' not found; task '{tdata.get('name')}' left unassigned."
                )
        try:
            task = Task.objects.create(
                project=project,
                name=tdata.get("name") or "Untitled task",
                start_date=datetime.date.fromisoformat(tdata["start_date"]),
                duration=tdata.get("duration", 1),
                progress=tdata.get("progress", 0),
                budget=Decimal(str(tdata.get("budget") or 0)),
                estimated_budget=Decimal(str(tdata.get("estimated_budget") or 0)),
                status=tdata.get("status") or Task.Status.ON_TRACK,
                task_type=tdata.get("task_type") or Task.TaskType.TASK,
                assignee=assignee,
                sort_order=tdata.get("sort_order", 0),
            )
        except (KeyError, TypeError, ValueError, InvalidOperation) as exc:
            raise ValueError(f"Invalid task data in project '{project.name}': {exc}")
        old_id = tdata.get("id")
        if old_id is not None:
            id_map[old_id] = task.id

    # Second pass, once every task has a new id: wire up parent links. This
    # can't be done in the creation loop above because a task's parent may
    # appear later in the list and not have a new id yet.
    for tdata in pdata.get("tasks", []):
        old_parent = tdata.get("parent")
        old_id = tdata.get("id")
        if old_parent is not None and old_id in id_map and old_parent in id_map:
            Task.objects.filter(pk=id_map[old_id]).update(parent_id=id_map[old_parent])

    for ddata in pdata.get("dependencies", []):
        pred = id_map.get(ddata.get("predecessor"))
        succ = id_map.get(ddata.get("successor"))
        if pred and succ:
            TaskDependency.objects.get_or_create(
                project=project,
                predecessor_id=pred,
                successor_id=succ,
                link_type=ddata.get("link_type")
                or TaskDependency.LinkType.FINISH_TO_START,
                defaults={"lag": ddata.get("lag", 0)},
            )
        else:
            warnings.append("Skipped a dependency referencing an unknown task.")

    for trdata in pdata.get("transitions", []):
        from_task = id_map.get(trdata.get("from_task"))
        to_task = id_map.get(trdata.get("to_task"))
        if from_task and to_task:
            try:
                TaskTransition.objects.create(
                    project=project,
                    from_task_id=from_task,
                    to_task_id=to_task,
                    on_date=datetime.date.fromisoformat(trdata["on_date"]),
                )
            except (KeyError, TypeError, ValueError):
                warnings.append("Skipped a malformed transition.")
        else:
            warnings.append("Skipped a transition referencing an unknown task.")

    for mdata in pdata.get("markers", []):
        task_id = id_map.get(mdata.get("task"))
        if task_id:
            try:
                TaskMarker.objects.create(
                    project=project,
                    task_id=task_id,
                    marker_type=mdata["marker_type"],
                    on_date=datetime.date.fromisoformat(mdata["on_date"]),
                    description=mdata.get("description") or "",
                )
            except (KeyError, TypeError, ValueError):
                warnings.append("Skipped a malformed marker.")
        else:
            warnings.append("Skipped a marker referencing an unknown task.")

    return {"action": action, "name": project.name, "warnings": warnings}
