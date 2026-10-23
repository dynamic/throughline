"""throughline - Hermes Agent plugin entry point.

Hermes requires an __init__.py beside plugin.yaml. The bridge itself lives in
hooks/post/hermes.py (next to the OMP shim) and is loaded here by path so the
repo root stays the single install unit for every harness.
"""
import importlib.util
import logging
from pathlib import Path

logger = logging.getLogger(__name__)
_BRIDGE = Path(__file__).resolve().parent / "hooks" / "post" / "hermes.py"


def register(ctx):
    try:
        spec = importlib.util.spec_from_file_location("throughline_hermes_bridge", _BRIDGE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception:
        logger.error("throughline: failed to load bridge at %s", _BRIDGE, exc_info=True)
        raise
    module.register(ctx)
