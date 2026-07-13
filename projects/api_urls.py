"""URL routing for the projects REST API (mounted separately from the
regular projects.urls used by the server-rendered board/settings pages)."""

from rest_framework.routers import DefaultRouter

from .api_views import ProjectViewSet

router = DefaultRouter()
router.register("projects", ProjectViewSet, basename="project")

urlpatterns = router.urls
