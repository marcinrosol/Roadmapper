"""App configuration for the core app."""

from django.apps import AppConfig


class CoreConfig(AppConfig):
    """Django app config for core (shared, cross-app functionality)."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "core"
