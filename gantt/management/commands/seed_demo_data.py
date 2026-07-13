import datetime

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from gantt.models import Task, TaskDependency, TaskMarker, TaskTransition
from projects.models import Project

User = get_user_model()

# Each project is a deep example: several levels of task hierarchy, budgets on
# every leaf (parents roll theirs up automatically), a spread of statuses/
# progress so the timeline looks lived-in, and multiples of every marker type.
# "children" nodes recurse; leaves carry budget/status/progress.
PROJECTS = [
    {
        "name": "Data Center Migration",
        "description": "Migrate core workloads from the legacy data center to the new regional facility.",
        "color": "#C98A2C",
        "must_exist": False,
        "tree": [
            {
                "name": "Planning & Assessment",
                "start_date": datetime.date(2026, 5, 4),
                "duration": 46,
                "children": [
                    {
                        "name": "Requirements Gathering",
                        "start_date": datetime.date(2026, 5, 4),
                        "duration": 10,
                        "budget": 15000,
                        "status": "complete",
                        "progress": 1.0,
                    },
                    {
                        "name": "Vendor Selection",
                        "start_date": datetime.date(2026, 5, 18),
                        "duration": 28,
                        "children": [
                            {
                                "name": "RFP Issued",
                                "start_date": datetime.date(2026, 5, 18),
                                "duration": 7,
                                "budget": 5000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                            {
                                "name": "Vendor Evaluation",
                                "start_date": datetime.date(2026, 5, 25),
                                "duration": 14,
                                "budget": 8000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                            {
                                "name": "Contract Signed",
                                "start_date": datetime.date(2026, 6, 8),
                                "duration": 5,
                                "budget": 2000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                        ],
                    },
                ],
            },
            {
                "name": "Infrastructure Build-out",
                "start_date": datetime.date(2026, 6, 15),
                "duration": 67,
                "children": [
                    {
                        "name": "Network Setup",
                        "start_date": datetime.date(2026, 6, 15),
                        "duration": 35,
                        "children": [
                            {
                                "name": "Core Switch Installation",
                                "start_date": datetime.date(2026, 6, 15),
                                "duration": 20,
                                "budget": 45000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                            {
                                "name": "Firewall Configuration",
                                "start_date": datetime.date(2026, 7, 6),
                                "duration": 15,
                                "budget": 20000,
                                "status": "at_risk",
                                "progress": 0.4,
                            },
                        ],
                    },
                    {
                        "name": "Server Provisioning",
                        "start_date": datetime.date(2026, 6, 15),
                        "duration": 43,
                        "children": [
                            {
                                "name": "Rack and Stack",
                                "start_date": datetime.date(2026, 6, 15),
                                "duration": 25,
                                "budget": 60000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                            {
                                "name": "OS Imaging",
                                "start_date": datetime.date(2026, 7, 10),
                                "duration": 12,
                                "budget": 10000,
                                "status": "on_track",
                                "progress": 0.3,
                            },
                            {
                                "name": "Storage Array Setup",
                                "start_date": datetime.date(2026, 7, 15),
                                "duration": 18,
                                "budget": 35000,
                                "status": "on_track",
                                "progress": 0.1,
                            },
                        ],
                    },
                ],
            },
            {
                "name": "Data Migration",
                "start_date": datetime.date(2026, 8, 24),
                "duration": 46,
                "children": [
                    {
                        "name": "Migration Rehearsal",
                        "start_date": datetime.date(2026, 8, 24),
                        "duration": 5,
                        "budget": 12000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Rollback Plan Validation",
                        "start_date": datetime.date(2026, 8, 24),
                        "duration": 10,
                        "budget": 8000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Production Cutover Window",
                        "start_date": datetime.date(2026, 9, 14),
                        "duration": 3,
                        "budget": 25000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                ],
            },
            {
                "name": "Validation & Handover",
                "start_date": datetime.date(2026, 9, 21),
                "duration": 32,
                "children": [
                    {
                        "name": "Post-Migration Testing",
                        "start_date": datetime.date(2026, 9, 21),
                        "duration": 15,
                        "budget": 18000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Documentation Handover",
                        "start_date": datetime.date(2026, 10, 6),
                        "duration": 8,
                        "budget": 6000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Go-Live Sign-off",
                        "start_date": datetime.date(2026, 10, 19),
                        "duration": 4,
                        "budget": 3000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                ],
            },
        ],
        "markers": [
            (
                "Contract Signed",
                "milestone",
                datetime.date(2026, 6, 13),
                "Vendor contract executed; infrastructure spend authorized.",
            ),
            (
                "Production Cutover Window",
                "milestone",
                datetime.date(2026, 9, 17),
                "Live cutover to the new data center.",
            ),
            (
                "Go-Live Sign-off",
                "milestone",
                datetime.date(2026, 10, 23),
                "Project formally closed out and handed to operations.",
            ),
            (
                "Vendor Evaluation",
                "key_event",
                datetime.date(2026, 5, 25),
                "Kickoff call with shortlisted vendors.",
            ),
            (
                "Migration Rehearsal",
                "key_event",
                datetime.date(2026, 8, 29),
                "Dry-run migration completed successfully.",
            ),
            (
                "Infrastructure Build-out",
                "decision_point",
                datetime.date(2026, 8, 1),
                "Go/no-go: is infrastructure ready for migration rehearsal?",
            ),
            (
                "Rollback Plan Validation",
                "decision_point",
                datetime.date(2026, 9, 1),
                "Decide whether the rollback plan is sound enough to proceed.",
            ),
        ],
        "dependencies": [
            ("RFP Issued", "Vendor Evaluation"),
            ("Vendor Evaluation", "Contract Signed"),
            ("Contract Signed", "Core Switch Installation"),
            ("Storage Array Setup", "Migration Rehearsal"),
            ("Migration Rehearsal", "Production Cutover Window"),
            ("Production Cutover Window", "Post-Migration Testing"),
        ],
        "transitions": [
            ("Contract Signed", "Firewall Configuration", datetime.date(2026, 6, 13)),
            ("Go-Live Sign-off", "Documentation Handover", datetime.date(2026, 10, 19)),
        ],
        # (from task name, target project name, target task name, on_date)
        "cross_transitions": [
            (
                "Production Cutover Window",
                "RA-7 Launch",
                "Pilot Line Assembly",
                datetime.date(2026, 9, 17),
            ),
        ],
    },
    {
        "name": "RA-7 Launch",
        "description": "Design, certify, and ramp production of the next-generation robotic arm.",
        "color": "#3C6E9E",
        "must_exist": False,
        "tree": [
            {
                "name": "Design & Engineering",
                "start_date": datetime.date(2026, 4, 6),
                "duration": 53,
                "children": [
                    {
                        "name": "Concept Design",
                        "start_date": datetime.date(2026, 4, 6),
                        "duration": 15,
                        "budget": 20000,
                        "status": "complete",
                        "progress": 1.0,
                    },
                    {
                        "name": "Prototype Fabrication",
                        "start_date": datetime.date(2026, 4, 21),
                        "duration": 25,
                        "children": [
                            {
                                "name": "3D Printed Prototype",
                                "start_date": datetime.date(2026, 4, 21),
                                "duration": 10,
                                "budget": 8000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                            {
                                "name": "Functional Prototype Build",
                                "start_date": datetime.date(2026, 5, 1),
                                "duration": 15,
                                "budget": 35000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                        ],
                    },
                    {
                        "name": "Design Review Sign-off",
                        "start_date": datetime.date(2026, 5, 26),
                        "duration": 3,
                        "budget": 4000,
                        "status": "complete",
                        "progress": 1.0,
                    },
                ],
            },
            {
                "name": "Manufacturing Setup",
                "start_date": datetime.date(2026, 6, 1),
                "duration": 54,
                "children": [
                    {
                        "name": "Tooling Procurement",
                        "start_date": datetime.date(2026, 6, 1),
                        "duration": 54,
                        "children": [
                            {
                                "name": "Tooling RFQ",
                                "start_date": datetime.date(2026, 6, 1),
                                "duration": 10,
                                "budget": 6000,
                                "status": "complete",
                                "progress": 1.0,
                            },
                            {
                                "name": "Tooling Fabrication",
                                "start_date": datetime.date(2026, 6, 15),
                                "duration": 40,
                                "budget": 120000,
                                "status": "at_risk",
                                "progress": 0.55,
                            },
                        ],
                    },
                    {
                        "name": "Pilot Line Assembly",
                        "start_date": datetime.date(2026, 7, 1),
                        "duration": 24,
                        "budget": 80000,
                        "status": "on_track",
                        "progress": 0.2,
                    },
                ],
            },
            {
                "name": "Certification & Compliance",
                "start_date": datetime.date(2026, 7, 27),
                "duration": 46,
                "children": [
                    {
                        "name": "Safety Testing",
                        "start_date": datetime.date(2026, 7, 27),
                        "duration": 21,
                        "budget": 45000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Regulatory Submission",
                        "start_date": datetime.date(2026, 8, 17),
                        "duration": 14,
                        "budget": 15000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Certification Approval",
                        "start_date": datetime.date(2026, 8, 31),
                        "duration": 12,
                        "budget": 5000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                ],
            },
            {
                "name": "Production Ramp",
                "start_date": datetime.date(2026, 9, 14),
                "duration": 53,
                "children": [
                    {
                        "name": "Initial Production Run",
                        "start_date": datetime.date(2026, 9, 14),
                        "duration": 45,
                        "budget": 250000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Quality Audit",
                        "start_date": datetime.date(2026, 10, 26),
                        "duration": 12,
                        "budget": 20000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                ],
            },
        ],
        "markers": [
            (
                "Design Review Sign-off",
                "milestone",
                datetime.date(2026, 5, 28),
                "Design frozen; released to manufacturing engineering.",
            ),
            (
                "Certification Approval",
                "milestone",
                datetime.date(2026, 9, 11),
                "UL certification received.",
            ),
            (
                "Initial Production Run",
                "milestone",
                datetime.date(2026, 10, 30),
                "First production unit off the line.",
            ),
            (
                "Safety Testing",
                "key_event",
                datetime.date(2026, 7, 27),
                "Independent lab testing begins.",
            ),
            (
                "Pilot Line Assembly",
                "decision_point",
                datetime.date(2026, 7, 20),
                "Go/no-go: is the pilot line ready for a trial run?",
            ),
        ],
        "dependencies": [
            ("3D Printed Prototype", "Functional Prototype Build"),
            ("Design Review Sign-off", "Tooling RFQ"),
            ("Tooling Fabrication", "Pilot Line Assembly"),
            ("Pilot Line Assembly", "Safety Testing"),
            ("Certification Approval", "Initial Production Run"),
        ],
        "transitions": [
            (
                "Design Review Sign-off",
                "Tooling Fabrication",
                datetime.date(2026, 5, 28),
            ),
        ],
        "cross_transitions": [],
    },
    {
        "name": "Office Renovation",
        "description": "Redesign and renovate the headquarters office space.",
        "color": "#2E6E5E",
        "must_exist": False,
        "tree": [
            {
                "name": "Design",
                "start_date": datetime.date(2026, 6, 1),
                "duration": 25,
                "children": [
                    {
                        "name": "Space Planning",
                        "start_date": datetime.date(2026, 6, 1),
                        "duration": 10,
                        "budget": 8000,
                        "status": "complete",
                        "progress": 1.0,
                    },
                    {
                        "name": "Furniture Selection",
                        "start_date": datetime.date(2026, 6, 8),
                        "duration": 18,
                        "budget": 25000,
                        "status": "complete",
                        "progress": 1.0,
                    },
                ],
            },
            {
                "name": "Construction",
                "start_date": datetime.date(2026, 6, 29),
                "duration": 46,
                "children": [
                    {
                        "name": "Demolition",
                        "start_date": datetime.date(2026, 6, 29),
                        "duration": 8,
                        "budget": 12000,
                        "status": "complete",
                        "progress": 1.0,
                    },
                    {
                        "name": "Electrical & HVAC",
                        "start_date": datetime.date(2026, 7, 8),
                        "duration": 25,
                        "budget": 45000,
                        "status": "at_risk",
                        "progress": 0.4,
                    },
                    {
                        "name": "Flooring & Paint",
                        "start_date": datetime.date(2026, 7, 20),
                        "duration": 20,
                        "budget": 30000,
                        "status": "on_track",
                        "progress": 0.1,
                    },
                ],
            },
            {
                "name": "Move-in",
                "start_date": datetime.date(2026, 8, 17),
                "duration": 19,
                "children": [
                    {
                        "name": "Furniture Install",
                        "start_date": datetime.date(2026, 8, 17),
                        "duration": 10,
                        "budget": 25000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                    {
                        "name": "Final Walkthrough",
                        "start_date": datetime.date(2026, 8, 31),
                        "duration": 4,
                        "budget": 3000,
                        "status": "on_track",
                        "progress": 0.0,
                    },
                ],
            },
        ],
        "markers": [
            (
                "Electrical & HVAC",
                "decision_point",
                datetime.date(2026, 7, 22),
                "Permit inspection: pass required before drywall closes the walls.",
            ),
            (
                "Furniture Install",
                "key_event",
                datetime.date(2026, 8, 17),
                "Furniture delivery arrives on site.",
            ),
            (
                "Final Walkthrough",
                "milestone",
                datetime.date(2026, 9, 4),
                "Office reopens for staff.",
            ),
        ],
        "dependencies": [
            ("Demolition", "Electrical & HVAC"),
            ("Electrical & HVAC", "Flooring & Paint"),
            ("Flooring & Paint", "Furniture Install"),
        ],
        "transitions": [
            ("Furniture Selection", "Furniture Install", datetime.date(2026, 6, 26)),
        ],
        "cross_transitions": [],
    },
]


class Command(BaseCommand):
    help = (
        "Seed the board with richly-populated example projects: several levels of "
        "task hierarchy, budgets on every leaf, multiple milestones/key events/"
        "decision points, dependencies, and transitions (including cross-project "
        "transitions). Creates 'Data Center Migration' if missing, and adds this "
        "same depth of example data to the existing 'RA-7 Launch' / 'Office Renovation' "
        "projects if they currently have no tasks."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--owner", default="admin", help="Username to own any newly-created project"
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Delete each project's existing tasks and reseed",
        )

    def handle(self, *args, **options):
        owner = User.objects.filter(username=options["owner"]).first()
        if owner is None:
            self.stderr.write(
                self.style.ERROR(f"No user named '{options['owner']}' found.")
            )
            return

        projects_by_name = {}
        by_name_per_project = {}

        with transaction.atomic():
            for spec in PROJECTS:
                name = spec["name"]
                project = Project.objects.filter(name=name).first()

                if project is None:
                    if spec.get("must_exist"):
                        self.stdout.write(
                            self.style.WARNING(f"Project '{name}' not found; skipping.")
                        )
                        continue
                    project = Project.objects.create(
                        name=name,
                        description=spec.get("description", ""),
                        owner=owner,
                        status=Project.Status.ACTIVE,
                        color=spec.get("color", "#3C6E9E"),
                    )
                else:
                    if project.tasks.exists():
                        if not options["force"]:
                            self.stdout.write(
                                self.style.WARNING(
                                    f"Project '{name}' (id={project.pk}) already has tasks; skipping. "
                                    f"Re-run with --force to wipe and reseed it."
                                )
                            )
                            continue
                        project.tasks.all().delete()

                projects_by_name[name] = project

                by_name = {}
                sort_counter = {"n": 0}

                def create_node(
                    node,
                    parent,
                    project=project,
                    by_name=by_name,
                    sort_counter=sort_counter,
                ):
                    sort_counter["n"] += 1
                    task = Task.objects.create(
                        project=project,
                        parent=parent,
                        name=node["name"],
                        start_date=node["start_date"],
                        duration=node["duration"],
                        status=node.get("status", Task.Status.ON_TRACK),
                        progress=node.get("progress", 0.0),
                        budget=node.get("budget", 0),
                        sort_order=sort_counter["n"],
                    )
                    by_name[node["name"]] = task
                    for child in node.get("children", []):
                        create_node(
                            child,
                            task,
                            project=project,
                            by_name=by_name,
                            sort_counter=sort_counter,
                        )

                for phase in spec["tree"]:
                    create_node(phase, None)
                by_name_per_project[name] = by_name

                marker_count = 0
                for task_name, marker_type, on_date, description in spec.get(
                    "markers", []
                ):
                    TaskMarker.objects.create(
                        project=project,
                        task=by_name[task_name],
                        marker_type=marker_type,
                        on_date=on_date,
                        description=description,
                    )
                    marker_count += 1

                dep_count = 0
                for pred_name, succ_name in spec.get("dependencies", []):
                    TaskDependency.objects.create(
                        project=project,
                        predecessor=by_name[pred_name],
                        successor=by_name[succ_name],
                    )
                    dep_count += 1

                trans_count = 0
                for from_name, to_name, on_date in spec.get("transitions", []):
                    TaskTransition.objects.create(
                        project=project,
                        from_task=by_name[from_name],
                        to_task=by_name[to_name],
                        on_date=on_date,
                    )
                    trans_count += 1

                self.stdout.write(
                    self.style.SUCCESS(
                        f"Seeded '{name}' (id={project.pk}): {len(by_name)} tasks, {marker_count} markers, "
                        f"{dep_count} dependencies, {trans_count} same-project transitions."
                    )
                )

            # Cross-project transitions, once every project's task-name map exists.
            cross_count = 0
            for spec in PROJECTS:
                from_by_name = by_name_per_project.get(spec["name"])
                if not from_by_name:
                    continue
                for (
                    from_name,
                    target_project_name,
                    target_task_name,
                    on_date,
                ) in spec.get("cross_transitions", []):
                    target_by_name = by_name_per_project.get(target_project_name)
                    if not target_by_name or target_task_name not in target_by_name:
                        continue
                    TaskTransition.objects.create(
                        project=projects_by_name[spec["name"]],
                        from_task=from_by_name[from_name],
                        to_task=target_by_name[target_task_name],
                        on_date=on_date,
                    )
                    cross_count += 1

            if cross_count:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Created {cross_count} cross-project transition(s)."
                    )
                )

        for name, project in projects_by_name.items():
            self.stdout.write(f"  '{name}' computed budget: ${project.budget:,.2f}")
