"""URL routing for the Gantt app's HTML/export views (non-API)."""

from django.urls import path

from . import views

app_name = "gantt"

urlpatterns = [
    path("projects/<int:pk>/", views.project_detail, name="project_detail"),
    path("projects/<int:pk>/export.csv", views.export_tasks_csv, name="export_csv"),
    path(
        "projects/<int:pk>/export.json", views.export_project_json, name="export_json"
    ),
]
