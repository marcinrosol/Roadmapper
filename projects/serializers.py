"""Serializers for exposing Project data to the board frontend and REST API."""

from rest_framework import serializers

from .models import Project


class ProjectBoardSerializer(serializers.ModelSerializer):
    """Project representation used on the gantt board and by the REST API.
    Adds owner_name (display convenience, avoids a frontend lookup by id) and
    exposes budget, which is a computed property on the model rather than a
    stored field."""

    owner_name = serializers.CharField(source="owner.username", read_only=True)

    class Meta:
        model = Project
        fields = ["id", "name", "owner", "owner_name", "status", "budget", "color"]
        # owner defaults to the requesting user on create (see ProjectViewSet
        # .perform_create), so it must not be required from the client.
        extra_kwargs = {"owner": {"required": False}}
