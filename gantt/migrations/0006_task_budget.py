from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("gantt", "0005_taskmarker"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="budget",
            field=models.DecimalField(
                blank=True, decimal_places=2, default=0, max_digits=12
            ),
        ),
    ]
