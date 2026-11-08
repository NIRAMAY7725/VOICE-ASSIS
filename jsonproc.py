"""JSON processing: validation, structure inspection, formatting and queries.

Validation, structure and formatting always use Python's built-in json
library. Queries use the jq binary when installed; otherwise simple dot-path
expressions ($.store.book[0].title) are evaluated by a pure-Python fallback,
and full jq filters produce an actionable DEPENDENCY_MISSING error.

Safety: jq runs with a fixed argument list, shell=False, a hard timeout and a
sanitized environment — jq's `env`/`$ENV` must never see backend secrets.
Parsed documents are guarded against excessive depth and node counts before
any operation, and query output is capped.
"""

import json
import os
import re
import shutil
import subprocess

from .config import (
    JSON_QUERY_TIMEOUT,
    MAX_FILE_BYTES,
    MAX_JSON_DEPTH,
    MAX_JSON_NODES,
    MAX_QUERY_OUTPUT_BYTES,
    MAX_QUERY_RESULTS,
    MAX_STRUCTURE_DEPTH,
    MAX_STRUCTURE_KEYS,
    MAX_TEXT_CHARS,
)
from .errors import (
    DependencyMissingError,
    EmptyFileError,
    FileTooLargeError,
    InvalidJsonError,
    InvalidRequestError,
    UnsupportedTypeError,
)
from .logging_setup import configure

log = configure()

JQ_INSTALL_HINT = (
    "jq is not installed or not on PATH. Windows: run 'winget install --id jqlang.jq' "
    "(or download from https://jqlang.github.io/jq/download/), then restart the server. "
    "If it is installed in a custom location, set MAYA_JQ_CMD to the full path of jq.exe "
    "in backend/.env. Simple dot-path queries like '$.store.book[0].title' still work "
    "without jq via the Python fallback."
)
WINDOWS_JQ_PATHS = (
    r"C:\Program Files\jq\jq.exe",
    r"C:\ProgramData\chocolatey\bin\jq.exe",
)

_OPERATIONS = {"validate", "structure", "format", "query"}


def _jq_cmd():
    command = os.environ.get("MAYA_JQ_CMD")
    if command:
        return command
    found = shutil.which("jq")
    if found:
        return found
    for candidate in WINDOWS_JQ_PATHS:
        if os.path.isfile(candidate):
            return candidate
    return None


def available() -> bool:
    """Health probe: True only if the jq binary actually runs."""
    command = _jq_cmd()
    if not command:
        return False
    try:
        result = subprocess.run([command, "--version"], shell=False, capture_output=True, timeout=5)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _parse_json(data):
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InvalidJsonError("The file is not valid UTF-8 text, so it cannot be JSON.") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise InvalidJsonError(f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}.") from exc
    except RecursionError as exc:
        raise InvalidJsonError(f"JSON is nested too deeply (limit {MAX_JSON_DEPTH} levels).") from exc


def _type_name(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object" if isinstance(value, dict) else "array"


def _guard(value):
    """Iteratively measure depth/node count and reject resource-exhausting input."""
    stack = [(value, 1)]
    nodes = 0
    max_depth = 0
    counts = {"object": 0, "array": 0, "string": 0, "number": 0, "boolean": 0, "null": 0}
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES:
            raise InvalidJsonError(f"JSON has too many values (limit {MAX_JSON_NODES}).")
        if depth > MAX_JSON_DEPTH:
            raise InvalidJsonError(f"JSON is nested too deeply (limit {MAX_JSON_DEPTH} levels).")
        max_depth = max(max_depth, depth)
        kind = _type_name(current)
        counts[kind] += 1
        if isinstance(current, dict):
            stack.extend((child, depth + 1) for child in current.values())
        elif isinstance(current, list):
            stack.extend((child, depth + 1) for child in current)
    return {"depth": max_depth, "nodeCount": nodes, "typeCounts": counts}


def _structure_tree(value, depth=1):
    kind = _type_name(value)
    if kind == "object":
        if depth > MAX_STRUCTURE_DEPTH:
            return {"type": "object", "keyCount": len(value), "truncated": True}
        keys = list(value.keys())
        shown = keys[:MAX_STRUCTURE_KEYS]
        node = {
            "type": "object",
            "keyCount": len(keys),
            "keys": {key: _structure_tree(value[key], depth + 1) for key in shown},
        }
        if len(keys) > len(shown):
            node["keysTruncated"] = True
        return node
    if kind == "array":
        if depth > MAX_STRUCTURE_DEPTH:
            return {"type": "array", "length": len(value), "truncated": True}
        node = {
            "type": "array",
            "length": len(value),
            "itemTypes": sorted({_type_name(item) for item in value}),
        }
        if value:
            node["itemSample"] = _structure_tree(value[0], depth + 1)
        return node
    return {"type": kind}


def _format(value, options):
    indent = options.get("indent", 2)
    sort_keys = options.get("sortKeys", False)
    if not isinstance(indent, int) or isinstance(indent, bool) or not 0 <= indent <= 8:
        raise InvalidRequestError("'indent' must be an integer between 0 (compact) and 8.")
    if not isinstance(sort_keys, bool):
        raise InvalidRequestError("'sortKeys' must be a boolean.")
    text = json.dumps(
        value,
        indent=indent or None,
        sort_keys=sort_keys,
        ensure_ascii=False,
        separators=None if indent else (",", ":"),
    )
    truncated = len(text) > MAX_TEXT_CHARS
    return {
        "operation": "format",
        "indent": indent,
        "sortKeys": sort_keys,
        "text": text[:MAX_TEXT_CHARS],
        "characters": min(len(text), MAX_TEXT_CHARS),
        "truncated": truncated,
    }


_PATH_TOKEN = re.compile(r'\.([A-Za-z_][A-Za-z0-9_]*)|\["([^"\]]+)"\]|\[\'([^\'\]]+)\'\]|\[(\d+)\]')


def _parse_path(expression):
    """Return path segments for a simple dot/bracket path, or None if not simple."""
    expr = expression.strip()
    if expr in {".", "$"}:
        return []
    if expr.startswith("$"):
        expr = expr[1:]
    if not expr or expr[0] not in ".[":
        return None
    segments = []
    position = 0
    while position < len(expr):
        match = _PATH_TOKEN.match(expr, position)
        if not match:
            return None
        dot_key, dq_key, sq_key, index = match.groups()
        segments.append(int(index) if index is not None else (dot_key or dq_key or sq_key))
        position = match.end()
    return segments


def _extract_path(value, segments):
    current = value
    for segment in segments:
        if isinstance(segment, int):
            if not isinstance(current, list):
                raise InvalidRequestError(f"Cannot use array index [{segment}] on a {_type_name(current)}.")
            current = current[segment] if segment < len(current) else None
        else:
            if not isinstance(current, dict):
                raise InvalidRequestError(f"Cannot use key '{segment}' on a {_type_name(current)}.")
            current = current.get(segment)
    return current


def _query_jq(command, data, expression):
    # jq exposes the process environment through env/$ENV — strip it so
    # backend secrets can never leak into query results.
    safe_env = {"PATH": os.environ.get("PATH", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
    try:
        result = subprocess.run(
            [command, "-c", expression],
            input=data,
            shell=False,
            capture_output=True,
            timeout=JSON_QUERY_TIMEOUT,
            env=safe_env,
        )
    except subprocess.TimeoutExpired as exc:
        raise InvalidRequestError(
            f"jq query timed out after {JSON_QUERY_TIMEOUT} seconds. Avoid unbounded filters like repeat()."
        ) from exc
    except OSError as exc:
        raise DependencyMissingError(f"jq could not be started: {str(exc)[:200]}. {JQ_INSTALL_HINT}") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise InvalidRequestError(f"jq filter failed: {detail[:300] or 'unknown error'}")
    if len(result.stdout) > MAX_QUERY_OUTPUT_BYTES:
        raise InvalidRequestError(
            f"jq query output exceeds the {MAX_QUERY_OUTPUT_BYTES // 1024} KB limit. Narrow the filter."
        )
    results = []
    truncated = False
    for line in result.stdout.decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        if len(results) >= MAX_QUERY_RESULTS:
            truncated = True
            break
        try:
            results.append(json.loads(line))
        except json.JSONDecodeError:
            results.append(line)
    return {"engine": "jq", "results": results, "resultCount": len(results), "truncated": truncated}


def _query(value, data, expression):
    if not isinstance(expression, str) or not expression.strip():
        raise InvalidRequestError("'expression' is required, e.g. '.items[0].name' or '.items | length'.")
    command = _jq_cmd()
    if command:
        payload = _query_jq(command, data, expression)
    else:
        segments = _parse_path(expression)
        if segments is None:
            raise DependencyMissingError(
                f"This query needs the jq binary. {JQ_INSTALL_HINT}"
            )
        results = [_extract_path(value, segments)]
        payload = {"engine": "python-fallback", "results": results, "resultCount": 1, "truncated": False}
    return {"operation": "query", "expression": expression, **payload}


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Validate/inspect/format/query a JSON document; return a JSON-serializable payload."""
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "validate")
    if operation not in _OPERATIONS:
        raise InvalidRequestError(f"Unknown JSON operation '{operation}'. Use one of: {', '.join(sorted(_OPERATIONS))}.")
    if not filename.lower().endswith(".json"):
        raise UnsupportedTypeError("JSON processing accepts .json files only.")
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise FileTooLargeError(f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB size limit.")

    value = _parse_json(data)
    stats = _guard(value)

    if operation == "validate":
        return {"operation": "validate", "valid": True, "topType": _type_name(value), "sizeBytes": len(data), **stats}
    if operation == "structure":
        return {"operation": "structure", "topType": _type_name(value), **stats, "tree": _structure_tree(value)}
    if operation == "format":
        return _format(value, options)
    return _query(value, data, options.get("expression"))