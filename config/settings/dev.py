"""Local development settings: relaxes DEBUG for verbose error pages."""

from .base import *  # noqa: F401,F403

# Safe here since this module is only used for local development, never
# for a deployed/public instance (see prod.py for the production settings).
DEBUG = True
