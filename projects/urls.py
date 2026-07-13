"""URL routes for the server-rendered board, portfolio export, and project
settings/membership pages."""

from django.urls import path

from . import views

app_name = "projects"

urlpatterns = [
    path("", views.board, name="board"),
    path("board/data/", views.board_data, name="board_data"),
    path("board/import/", views.board_import, name="board_import"),
    path(
        "portfolio/export.csv", views.portfolio_export_csv, name="portfolio_export_csv"
    ),
    path(
        "portfolio/export.json",
        views.portfolio_export_json,
        name="portfolio_export_json",
    ),
    path("projects/<int:pk>/settings/", views.project_settings, name="settings"),
    path("projects/<int:pk>/members/", views.member_list_partial, name="member_list"),
    path("projects/<int:pk>/members/add/", views.member_add, name="member_add"),
    path(
        "projects/<int:pk>/members/<int:uid>/remove/",
        views.member_remove,
        name="member_remove",
    ),
]
