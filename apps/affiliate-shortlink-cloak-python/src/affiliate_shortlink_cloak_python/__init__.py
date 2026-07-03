"""Minimal parallel Python CloakBrowser prototype."""

from __future__ import annotations

import os

__version__ = "0.0.1"

APP_NAME = "affiliate-shortlink-cloak-python"
BACKEND = "python-cloakbrowser"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8811
DEFAULT_PROFILE_ROOT = os.path.join(
    os.path.expanduser("~"),
    ".affiliate-shortlink-cloak-python",
    "profiles",
)
SHOPEE_CUSTOM_LINK_URL = "https://affiliate.shopee.co.th/offer/custom_link"

__all__ = [
    "APP_NAME",
    "BACKEND",
    "DEFAULT_HOST",
    "DEFAULT_PORT",
    "DEFAULT_PROFILE_ROOT",
    "SHOPEE_CUSTOM_LINK_URL",
    "__version__",
]
