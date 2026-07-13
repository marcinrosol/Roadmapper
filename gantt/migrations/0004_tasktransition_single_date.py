from django.db import migrations, models


def backfill_on_date(apps, schema_editor):
    TaskTransition = apps.get_model("gantt", "TaskTransition")
    for tr in TaskTransition.objects.all():
        tr.on_date = tr.from_date
        tr.save(update_fields=["on_date"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("gantt", "0003_alter_task_task_type_tasktransition"),
    ]

    operations = [
        migrations.AddField(
            model_name="tasktransition",
            name="on_date",
            field=models.DateField(null=True),
        ),
        migrations.RunPython(backfill_on_date, noop_reverse),
        migrations.RemoveField(
            model_name="tasktransition",
            name="from_date",
        ),
        migrations.RemoveField(
            model_name="tasktransition",
            name="to_date",
        ),
        migrations.AlterField(
            model_name="tasktransition",
            name="on_date",
            field=models.DateField(),
        ),
    ]
