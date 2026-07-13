"""Root URL configuration: wires up admin, auth, REST APIs, and app-level routes."""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("accounts/", include("django.contrib.auth.urls")),
    # Both apps' API routes are mounted under the same "api/" prefix; their
    # url patterns must not collide since Django tries them in order.
    path("api/", include("gantt.api_urls")),
    path("api/", include("projects.api_urls")),
    path("", include("projects.urls")),
    path("", include("gantt.urls")),
]
