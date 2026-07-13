"""URL routing for the Gantt REST API: registers a DRF router covering tasks,
dependency links, transitions, and markers."""

from rest_framework.routers import DefaultRouter

from .api_views import (
    TaskLinkViewSet,
    TaskMarkerViewSet,
    TaskTransitionViewSet,
    TaskViewSet,
)

router = DefaultRouter()
router.register("tasks", TaskViewSet, basename="task")
router.register("links", TaskLinkViewSet, basename="link")
router.register("transitions", TaskTransitionViewSet, basename="transition")
router.register("markers", TaskMarkerViewSet, basename="marker")

urlpatterns = router.urls
