import django.db.models.deletion
from django.db import migrations, models

POINT_TYPES = ["milestone", "key_event", "decision_point"]


def migrate_point_tasks_to_markers(apps, schema_editor):
    Task = apps.get_model("gantt", "Task")
    TaskMarker = apps.get_model("gantt", "TaskMarker")
    point_tasks = Task.objects.filter(task_type__in=POINT_TYPES)
    for t in point_tasks:
        anchor = t.parent
        if anchor is None:
            anchor = (
                Task.objects.filter(project_id=t.project_id, parent__isnull=True)
                .exclude(pk=t.pk)
                .exclude(task_type__in=POINT_TYPES)
                .order_by("sort_order", "id")
                .first()
            )
        if anchor is not None:
            TaskMarker.objects.create(
                project_id=t.project_id,
                task_id=anchor.id,
                marker_type=t.task_type,
                on_date=t.start_date,
                description=t.name,
            )
    point_tasks.delete()


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("gantt", "0004_tasktransition_single_date"),
    ]

    operations = [
        migrations.CreateModel(
            name="TaskMarker",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "marker_type",
                    models.CharField(
                        choices=[
                            ("milestone", "Milestone"),
                            ("key_event", "Key event"),
                            ("decision_point", "Decision point"),
                        ],
                        max_length=20,
                    ),
                ),
                ("on_date", models.DateField()),
                ("description", models.CharField(blank=True, max_length=255)),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="task_markers",
                        to="projects.project",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="markers",
                        to="gantt.task",
                    ),
                ),
            ],
            options={
                "ordering": ["on_date"],
            },
        ),
        migrations.RunPython(migrate_point_tasks_to_markers, noop_reverse),
        migrations.AlterField(
            model_name="task",
            name="task_type",
            field=models.CharField(
                choices=[("task", "Task"), ("project", "Summary")],
                default="task",
                max_length=20,
            ),
        ),
    ]
