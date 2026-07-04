"""Minimal parallel Python CloakBrowser prototype."""

from __future__ import annotations

import os

__version__ = "0.0.1"

APP_NAME = "affiliate-shortlink-cloak-python"

# Selectable browser backends. The default remains the existing Python
# CloakBrowser/Playwright backend so behavior is unchanged unless a backend env
# explicitly opts into the side-by-side Stealth/nodriver backend.
BACKEND_CLOAKBROWSER = "python-cloakbrowser"
BACKEND_STEALTH = "python-stealth-nodriver"
BACKEND = BACKEND_CLOAKBROWSER

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8811
DEFAULT_PROFILE_ROOT = os.path.join(
    os.path.expanduser("~"),
    ".affiliate-shortlink-cloak-python",
    "profiles",
)
# Profile root only used when the Stealth/nodriver backend is selected. It maps
# to the already-installed Stealth Browser profiles directory.
DEFAULT_STEALTH_PROFILE_ROOT = os.path.join(
    os.path.expanduser("~"),
    ".stealth-browser-mcp",
    "profiles",
)
SHOPEE_CUSTOM_LINK_URL = "https://affiliate.shopee.co.th/offer/custom_link"

__all__ = [
    "APP_NAME",
    "BACKEND",
    "BACKEND_CLOAKBROWSER",
    "BACKEND_STEALTH",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DEFAULT_PROFILE_ROOT",
    "DEFAULT_STEALTH_PROFILE_ROOT",
    "SHOPEE_CUSTOM_LINK_URL",
    "__version__",
]
