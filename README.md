# Roadmapper

A multi-project Gantt/roadmap planning board. Projects contain a hierarchy of
tasks (phases → sub-phases → leaf tasks) with budgets, progress, and status
that roll up automatically to their parents. Tasks can depend on one another,
transition into tasks in *other* projects, and carry milestone / key-event /
decision-point markers. The board renders a portfolio view across all
projects and a drill-in view per project, with fiscal-year/quarter timeline
bands, a critical-path highlighter, filtering, and CSV/JSON export.

The frontend is a single dependency-free JavaScript file
(`static/board/board.js`) talking to a Django REST Framework API — no
frontend build step required.

## Stack

- Django 5.2, Django REST Framework
- PostgreSQL (via `psycopg`)
- `django-environ` for `.env`-based settings
- `django-htmx`, `django-widget-tweaks` for the server-rendered pages
- Vanilla JS/CSS for the Gantt board (`static/board/`)

## Setup

### 1. Database

Start Postgres with Docker Compose:

```bash
docker compose up -d
```

This starts a `postgres:16` container matching the credentials in
`docker-compose.yml` (`roadmapper` / `roadmapper`, exposed on `5432`).

### 2. Python environment

```bash
python -m venv venv
# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
```

### 3. Environment variables

```bash
cp .env.example .env
```

Edit `.env` and set at least `SECRET_KEY` to a unique value. `DATABASE_URL`
should already match the Docker Compose Postgres instance.

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Django's cryptographic signing key. Generate a fresh one per environment — never reuse the example value. |
| `DEBUG` | `True` for local development only. Must be `False` in any deployed environment. |
| `ALLOWED_HOSTS` | Comma-separated hostnames Django will serve. |
| `DATABASE_URL` | Postgres connection string, parsed by `django-environ`. |

### 4. Migrate and create an admin user

```bash
python manage.py migrate
python manage.py createsuperuser
```

### 5. (Optional) Seed demo data

A management command populates the board with a few richly-detailed example
projects (multi-level task hierarchies, budgets, dependencies, transitions,
and all three marker types) so there's something to look at immediately:

```bash
python manage.py seed_demo_data
```

It only touches projects that don't already have tasks; pass `--force` to
wipe and reseed a project that does.

### 6. Run the dev server

```bash
python manage.py runserver
```

Visit `http://127.0.0.1:8000/` and log in with the superuser you created.

## Project layout

| App | Responsibility |
|---|---|
| `accounts` | Reserved for user-related models/views beyond Django's built-in auth (currently scaffolding only — login/logout are handled by `django.contrib.auth.urls`). |
| `core` | Shared base template (`core/templates/core/base.html`) and the login page template. |
| `projects` | The `Project` model, membership/permissions, the board page, and portfolio-level import/export. |
| `gantt` | The `Task` hierarchy, `TaskDependency`, `TaskTransition`, `TaskMarker` models, the REST API, and per-project export. |
| `config` | Django settings (`config/settings/{base,dev,prod}.py`), URL root, WSGI/ASGI entrypoints. |

## Running tests

```bash
python manage.py test
```

## Settings

`config/settings/base.py` holds settings shared by every environment;
`dev.py` and `prod.py` layer environment-specific overrides on top. Point
`DJANGO_SETTINGS_MODULE` at whichever you need (`manage.py` defaults to
`config.settings.dev`).
