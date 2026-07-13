"""Production settings: disables debug output and enforces HTTPS-only cookies."""

from .base import *  # noqa: F401,F403

# Must be False in production so stack traces/settings are never leaked to users.
DEBUG = False

# Assumes TLS is terminated in front of Django (e.g. by a load balancer/proxy);
# without HTTPS actually being served, SECURE_SSL_REDIRECT causes redirect loops.
SECURE_SSL_REDIRECT = True
# Session/CSRF cookies are only sent over HTTPS, preventing them from leaking
# over plain HTTP.
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
