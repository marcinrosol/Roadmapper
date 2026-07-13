"""Django admin registrations for the projects app."""

from django.contrib import admin

from .models import Project, ProjectMembership


class ProjectMembershipInline(admin.TabularInline):
    """Lets memberships be added/edited directly from the Project admin page."""

    model = ProjectMembership
    extra = 1


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    """Admin list/detail view for projects, with membership management inline."""

    list_display = ("name", "owner", "status", "budget", "color", "created_at")
    list_filter = ("status",)
    search_fields = ("name",)
    inlines = [ProjectMembershipInline]


@admin.register(ProjectMembership)
class ProjectMembershipAdmin(admin.ModelAdmin):
    """Standalone admin view for memberships (mainly useful for bulk lookup;
    day-to-day editing happens via the ProjectMembershipInline)."""

    list_display = ("project", "user", "role", "added_at")
    list_filter = ("role",)
