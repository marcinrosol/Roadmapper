"""Tests for the Gantt app: task API access control, dependency cycle
detection, and CSV/JSON export-import round-tripping."""

import datetime
import json

from django.contrib.auth import get_user_model
from django.test import TestCase

from projects.models import Project

from .exports import build_board_export, import_board_data
from .models import Task, TaskDependency, TaskTransition
from .validators import would_create_cycle

User = get_user_model()


class TaskApiTests(TestCase):
    """Task creation via the API and project-membership access control."""

    def setUp(self):
        self.owner = User.objects.create_user("owner", password="pass12345")
        self.project = Project.objects.create(name="Test project", owner=self.owner)
        self.client.login(username="owner", password="pass12345")

    def test_create_task_via_api(self):
        response = self.client.post(
            "/api/tasks/",
            data={
                "project": self.project.pk,
                "name": "Design",
                "start_date": "2026-07-10",
                "duration": 5,
                "progress": 0,
                "parent": None,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertTrue(
            Task.objects.filter(name="Design", project=self.project).exists()
        )

    def test_outsider_cannot_create_task(self):
        outsider = User.objects.create_user("outsider", password="pass12345")
        self.client.logout()
        self.client.login(username="outsider", password="pass12345")
        response = self.client.post(
            "/api/tasks/",
            data={
                "project": self.project.pk,
                "name": "Design",
                "start_date": "2026-07-10",
                "duration": 5,
                "progress": 0,
                "parent": None,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)


class CycleDetectionTests(TestCase):
    """would_create_cycle and the API's rejection of circular/self links."""

    def setUp(self):
        owner = User.objects.create_user("owner", password="pass12345")
        self.project = Project.objects.create(name="Test project", owner=owner)
        self.client.login(username="owner", password="pass12345")
        self.a = Task.objects.create(
            project=self.project, name="A", start_date=datetime.date(2026, 7, 1)
        )
        self.b = Task.objects.create(
            project=self.project, name="B", start_date=datetime.date(2026, 7, 1)
        )
        self.c = Task.objects.create(
            project=self.project, name="C", start_date=datetime.date(2026, 7, 1)
        )
        TaskDependency.objects.create(
            project=self.project, predecessor=self.a, successor=self.b
        )
        TaskDependency.objects.create(
            project=self.project, predecessor=self.b, successor=self.c
        )

    def test_would_create_cycle_detects_indirect_cycle(self):
        self.assertTrue(would_create_cycle(self.c.pk, self.a.pk, self.project.pk))

    def test_would_create_cycle_allows_valid_link(self):
        d = Task.objects.create(
            project=self.project, name="D", start_date=datetime.date(2026, 7, 1)
        )
        self.assertFalse(would_create_cycle(self.c.pk, d.pk, self.project.pk))

    def test_api_rejects_circular_link(self):
        response = self.client.post(
            "/api/links/",
            data={
                "project": self.project.pk,
                "predecessor": self.c.pk,
                "successor": self.a.pk,
                "link_type": "finish_to_start",
                "lag": 0,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_api_rejects_self_link(self):
        response = self.client.post(
            "/api/links/",
            data={
                "project": self.project.pk,
                "predecessor": self.a.pk,
                "successor": self.a.pk,
                "link_type": "finish_to_start",
                "lag": 0,
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)


class ExportCsvTests(TestCase):
    """CSV/JSON export endpoints, including access control for outsiders."""

    def setUp(self):
        self.owner = User.objects.create_user("owner", password="pass12345")
        self.project = Project.objects.create(name="Test project", owner=self.owner)
        self.client.login(username="owner", password="pass12345")
        self.task = Task.objects.create(
            project=self.project,
            name="Design phase",
            start_date=datetime.date(2026, 7, 1),
            duration=5,
        )

    def test_export_csv_returns_task_row(self):
        response = self.client.get(f"/projects/{self.project.pk}/export.csv")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/csv")
        body = response.content.decode()
        self.assertIn("Task", body.splitlines()[0])
        self.assertIn("Design phase", body)

    def test_outsider_cannot_export_csv(self):
        outsider = User.objects.create_user("outsider", password="pass12345")
        self.client.logout()
        self.client.login(username="outsider", password="pass12345")
        response = self.client.get(f"/projects/{self.project.pk}/export.csv")
        self.assertEqual(response.status_code, 404)

    def test_export_json_returns_task_row(self):
        response = self.client.get(f"/projects/{self.project.pk}/export.json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/json")
        data = json.loads(response.content)
        self.assertEqual(data["format"], "roadmapper-board-export")
        self.assertEqual(len(data["projects"]), 1)
        self.assertEqual(data["projects"][0]["tasks"][0]["name"], "Design phase")


class BoardExportImportTests(TestCase):
    """Round-tripping build_board_export/import_board_data: new-project
    creation, in-place update, ownership checks, and malformed-input handling."""

    def setUp(self):
        self.owner = User.objects.create_user("owner", password="pass12345")
        self.assignee = User.objects.create_user("worker", password="pass12345")
        self.project = Project.objects.create(
            name="Original project", owner=self.owner, color="#123456"
        )
        self.parent = Task.objects.create(
            project=self.project,
            name="Parent",
            start_date=datetime.date(2026, 7, 1),
            duration=10,
            assignee=self.assignee,
        )
        self.child = Task.objects.create(
            project=self.project,
            name="Child",
            parent=self.parent,
            start_date=datetime.date(2026, 7, 2),
            duration=3,
            budget=1000,
        )
        TaskDependency.objects.create(
            project=self.project, predecessor=self.parent, successor=self.child
        )
        TaskTransition.objects.create(
            project=self.project,
            from_task=self.parent,
            to_task=self.child,
            on_date=datetime.date(2026, 7, 1),
        )

    def test_round_trip_creates_new_project_with_hierarchy_and_links(self):
        export = build_board_export([self.project])
        # Simulate importing into a fresh instance with no matching project id.
        export["projects"][0]["id"] = 999999
        summary = import_board_data(self.owner, export)

        self.assertEqual(summary["created"], ["Original project"])
        self.assertEqual(summary["updated"], [])
        self.assertEqual(summary["warnings"], [])

        imported = Project.objects.exclude(pk=self.project.pk).get(
            name="Original project"
        )
        self.assertEqual(str(imported.budget), "1000.00")
        self.assertEqual(imported.color, "#123456")
        self.assertEqual(imported.owner, self.owner)

        parent = imported.tasks.get(name="Parent")
        child = imported.tasks.get(name="Child")
        self.assertEqual(child.parent_id, parent.id)
        self.assertEqual(parent.assignee, self.assignee)
        self.assertTrue(
            TaskDependency.objects.filter(
                project=imported, predecessor=parent, successor=child
            ).exists()
        )
        self.assertTrue(
            TaskTransition.objects.filter(
                project=imported, from_task=parent, to_task=child
            ).exists()
        )

    def test_update_in_place_replaces_tasks(self):
        export = build_board_export([self.project])
        export["projects"][0]["name"] = "Renamed project"
        export["projects"][0]["tasks"] = [
            {
                "id": 1,
                "name": "Only task",
                "parent": None,
                "start_date": "2026-08-01",
                "duration": 1,
                "progress": 0,
            }
        ]
        export["projects"][0]["dependencies"] = []
        export["projects"][0]["transitions"] = []

        summary = import_board_data(self.owner, export)

        self.assertEqual(summary["updated"], ["Renamed project"])
        self.project.refresh_from_db()
        self.assertEqual(self.project.name, "Renamed project")
        self.assertEqual(
            list(self.project.tasks.values_list("name", flat=True)), ["Only task"]
        )

    def test_outsider_import_creates_new_project_instead_of_overwriting(self):
        outsider = User.objects.create_user("outsider", password="pass12345")
        export = build_board_export([self.project])  # id points at owner's real project

        summary = import_board_data(outsider, export)

        self.assertEqual(summary["created"], ["Original project"])
        self.project.refresh_from_db()
        self.assertEqual(self.project.name, "Original project")  # untouched
        imported = Project.objects.get(owner=outsider, name="Original project")
        self.assertEqual(imported.tasks.count(), 2)

    def test_unassignable_assignee_produces_warning_not_error(self):
        export = build_board_export([self.project])
        export["projects"][0]["id"] = 999999
        export["projects"][0]["tasks"][0]["assignee_username"] = "nonexistent-user"

        summary = import_board_data(self.owner, export)

        self.assertEqual(len(summary["warnings"]), 1)
        self.assertIn("nonexistent-user", summary["warnings"][0])

    def test_rejects_malformed_format(self):
        with self.assertRaises(ValueError):
            import_board_data(
                self.owner, {"format": "not-a-real-format", "projects": []}
            )

    def test_board_import_view_endpoint(self):
        self.client.login(username="owner", password="pass12345")
        export = build_board_export([self.project])
        export["projects"][0]["id"] = 999999
        response = self.client.post(
            "/board/import/", data=export, content_type="application/json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(body["created"], ["Original project"])
