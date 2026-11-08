"""MAYA File Intelligence — Python core processing engine.

Public reusable API:
    detect_type(data, filename)      -> content-first type detection
    validate_file(data, filename, …) -> size / extension / consistency checks
    extract_metadata(data, type, …)  -> structural metadata (best effort)
    handle_request(request_dict)     -> full JSON protocol pipeline
"""

__version__ = "1.0.0"

from .detector import detect_type
from .validator import validate_file
from .metadata import extract_metadata
from .pipeline import handle_request

__all__ = ["__version__", "detect_type", "validate_file", "extract_metadata", "handle_request"]