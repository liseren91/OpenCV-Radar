"""Source registry: auto-discovers every source module in this package.

A source module defines:
  NAME: str
  REQUIRES_ENV: list[str]          (default [])
  ENABLED_BY_DEFAULT: bool         (default True)
  fetch(config: dict) -> list[dict]
"""

import importlib
import os
import pkgutil


def _split_env(name):
    return [s.strip() for s in os.getenv(name, "").split(",") if s.strip()]


def load_sources():
    enabled = set(_split_env("SOURCES_ENABLED"))
    disabled = set(_split_env("SOURCES_DISABLED"))
    sources = []
    for mod_info in pkgutil.iter_modules(__path__):
        if mod_info.name in {"base"}:
            continue
        module = importlib.import_module(f"{__name__}.{mod_info.name}")
        if not hasattr(module, "NAME") or not hasattr(module, "fetch"):
            continue
        name = module.NAME
        if getattr(module, "ENABLED_BY_DEFAULT", True) is False and name not in enabled:
            continue
        if enabled and name not in enabled:
            continue
        if name in disabled:
            continue
        sources.append(module)
    return sources
