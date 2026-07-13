from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("gantt", "0006_task_budget"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="estimated_budget",
            field=models.DecimalField(
                blank=True,
                decimal_places=2,
                default=0,
                max_digits=12,
                help_text="Placeholder/ballpark budget, independent of the actual budget above.",
            ),
        ),
    ]
