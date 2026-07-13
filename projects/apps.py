"""App configuration for the projects app."""

from django.apps import AppConfig


class ProjectsConfig(AppConfig):
    """Standard Django AppConfig for the projects app."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "projects"
