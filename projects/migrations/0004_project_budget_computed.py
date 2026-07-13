from django.db import migrations


def move_project_budget_onto_a_task(apps, schema_editor):
    """Project.budget is becoming a computed sum of leaf tasks' budgets. Any
    existing manually-entered project budget has no per-task source to derive
    from, so preserve it by dumping the whole amount onto one leaf task (a
    task with no children) rather than silently losing the value — anchoring
    it on a non-leaf (summary) task would make it invisible to the new sum."""
    Project = apps.get_model("projects", "Project")
    Task = apps.get_model("gantt", "Task")
    for project in Project.objects.exclude(budget=0):
        anchor = (
            Task.objects.filter(project=project, children__isnull=True)
            .order_by("sort_order", "id")
            .first()
        )
        if anchor is not None:
            anchor.budget = project.budget
            anchor.save(update_fields=["budget"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("projects", "0003_alter_project_budget_alter_project_color"),
        ("gantt", "0006_task_budget"),
    ]

    operations = [
        migrations.RunPython(move_project_budget_onto_a_task, noop_reverse),
        migrations.RemoveField(
            model_name="project",
            name="budget",
        ),
    ]
