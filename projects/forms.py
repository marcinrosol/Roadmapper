"""Forms used by the server-rendered project settings/board views."""

from django import forms
from django.contrib.auth import get_user_model

from .models import Project

User = get_user_model()


class ProjectForm(forms.ModelForm):
    """Edits a project's basic settings. Uses a native color picker widget
    for the project's board/gantt color."""

    class Meta:
        model = Project
        fields = ["name", "description", "status", "color"]
        widgets = {
            "color": forms.TextInput(
                attrs={"type": "color", "style": "width:auto;padding:2px;"}
            ),
        }


class MemberAddForm(forms.Form):
    """Adds a project member by username (rather than by user id), used by
    the member-management partial on the project settings page."""

    username = forms.CharField(max_length=150)

    def clean_username(self):
        """Reject usernames that don't correspond to an existing user."""
        username = self.cleaned_data["username"]
        if not User.objects.filter(username=username).exists():
            raise forms.ValidationError("No user with that username.")
        return username
