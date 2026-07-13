"""Tests for project visibility rules and the board/portfolio views."""

import datetime

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from gantt.models import Task

from .models import Project, ProjectMembership

User = get_user_model()


class ProjectAccessTests(TestCase):
    """Verifies board_data only returns projects the requesting user owns
    or is a member of, and that anonymous access is redirected to login."""

    def setUp(self):
        self.owner = User.objects.create_user("owner", password="pass12345")
        self.member = User.objects.create_user("member", password="pass12345")
        self.outsider = User.objects.create_user("outsider", password="pass12345")
        self.project = Project.objects.create(name="Test project", owner=self.owner)
        ProjectMembership.objects.create(project=self.project, user=self.member)

    def test_owner_sees_project_in_board_data(self):
        self.client.login(username="owner", password="pass12345")
        response = self.client.get(reverse("projects:board_data"))
        self.assertEqual(response.status_code, 200)
        ids = [p["id"] for p in response.json()["projects"]]
        self.assertIn(self.project.pk, ids)

    def test_member_sees_project_in_board_data(self):
        self.client.login(username="member", password="pass12345")
        response = self.client.get(reverse("projects:board_data"))
        self.assertEqual(response.status_code, 200)
        ids = [p["id"] for p in response.json()["projects"]]
        self.assertIn(self.project.pk, ids)

    def test_outsider_does_not_see_project_in_board_data(self):
        self.client.login(username="outsider", password="pass12345")
        response = self.client.get(reverse("projects:board_data"))
        self.assertEqual(response.status_code, 200)
        ids = [p["id"] for p in response.json()["projects"]]
        self.assertNotIn(self.project.pk, ids)

    def test_anonymous_redirected_to_login(self):
        response = self.client.get(reverse("projects:board_data"))
        self.assertEqual(response.status_code, 302)


class BoardTests(TestCase):
    """Smoke tests for the board page/data endpoints and the CSV export."""

    def setUp(self):
        self.owner = User.objects.create_user("owner", password="pass12345")
        self.project = Project.objects.create(name="Test project", owner=self.owner)
        self.client.login(username="owner", password="pass12345")

    def test_board_page_loads(self):
        response = self.client.get(reverse("projects:board"))
        self.assertEqual(response.status_code, 200)

    def test_board_data_handles_project_with_no_tasks(self):
        response = self.client.get(reverse("projects:board_data"))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["tasks"]), 0)
        self.assertEqual(data["projects"][0]["name"], "Test project")

    def test_portfolio_export_csv(self):
        Task.objects.create(
            project=self.project,
            name="Kickoff",
            start_date=datetime.date(2026, 7, 1),
            duration=3,
        )
        response = self.client.get(reverse("projects:portfolio_export_csv"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/csv")
        body = response.content.decode()
        self.assertIn("Project", body.splitlines()[0])
        self.assertIn("Kickoff", body)
