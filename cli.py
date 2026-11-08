"""CLI boundary: one JSON request on stdin, one JSON response on stdout.

All logging goes to stderr. Handled errors produce {"ok": false, "error":
{code, message, status}} with exit code 0 so the backend can translate them;
unexpected exceptions are logged and converted to a generic failure without
leaking internals.
"""

import json
import sys

from .config import MAX_STDIN_BYTES
from .errors import EngineError, InvalidRequestError
from .logging_setup import configure
from .pipeline import handle_request

log = configure()


def _emit(response):
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--version" in argv:
        from . import __version__

        print(f"maya-file-engine {__version__}")
        return 0

    request = {}
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            raise InvalidRequestError("Request exceeds the stdin size limit.")
        request = json.loads(raw.decode("utf-8"))
        if not isinstance(request, dict):
            raise InvalidRequestError("Request must be a JSON object.")
    except (json.JSONDecodeError, UnicodeDecodeError):
        _emit({"ok": False, "error": InvalidRequestError("Stdin did not contain a valid JSON request.").to_dict()})
        return 0
    except EngineError as exc:
        _emit({"ok": False, "error": exc.to_dict()})
        return 0

    try:
        response = handle_request(request)
    except EngineError as exc:
        log.warning(f"{exc.code}: {exc}")
        response = {"ok": False, "requestId": request.get("requestId"), "error": exc.to_dict()}
    except Exception:
        log.exception("unexpected engine failure")
        response = {
            "ok": False,
            "requestId": request.get("requestId"),
            "error": {"code": "PROCESSING_FAILED", "message": "The engine failed to process this file.", "status": 500},
        }

    _emit(response)
    return 0