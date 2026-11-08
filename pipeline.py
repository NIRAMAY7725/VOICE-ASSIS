"""Request pipeline: detect -> validate -> metadata -> process -> JSON.

Reusable both as a library (handle_request) and through the CLI protocol.
Actions: health, detect, validate, metadata, process (default), tabular,
spreadsheet, pdf, ocr, convert, json, archive, utils.
"""

import base64
import binascii
import importlib
import sys
import time
import uuid
from pathlib import Path

from . import archive, cliutils, convert, detector, jsonproc, metadata, ocr, pdf, spreadsheet, tabular, validator
from .errors import InvalidRequestError, NoTextError, UnsupportedTypeError
from .logging_setup import configure
from .processors import get_processor
from .processors.base import clip_text

log = configure()

VALID_ACTIONS = {"health", "detect", "validate", "metadata", "process", "tabular", "spreadsheet", "pdf", "ocr", "convert", "json", "archive", "utils"}
DEPENDENCY_PROBES = (("pypdf", "pdf"), ("docx", "docx"), ("openpyxl", "xlsx"), ("pandas", "tabular"))


def _health():
    from . import __version__

    capabilities = {"txt": True, "csv": True}
    for module, label in DEPENDENCY_PROBES:
        try:
            importlib.import_module(module)
            capabilities[label] = True
        except ImportError:
            capabilities[label] = False
    capabilities["xlsm"] = capabilities["xlsx"]
    capabilities["ocr"] = ocr.available()
    capabilities["convert"] = convert.available()
    capabilities["json"] = True  # built-in json library; jq only adds full filters
    capabilities["jq"] = jsonproc.available()
    capabilities["archive"] = True  # tarfile listing; GNU tar only needed to extract
    capabilities["gnuTar"] = archive.available()
    capabilities["utils"] = True  # status + Python fallbacks; binaries optional
    return {
        "ok": True,
        "engine": "maya-file-engine",
        "version": __version__,
        "python": sys.version.split()[0],
        "capabilities": capabilities,
    }


def _safe_name(filename):
    return Path(filename).name.replace("\r", " ").replace("\n", " ")


def handle_request(request: dict) -> dict:
    """Run one protocol request and return a JSON-serializable response."""
    if not isinstance(request, dict):
        raise InvalidRequestError("Request must be a JSON object.")
    request_id = str(request.get("requestId") or uuid.uuid4())
    action = request.get("action") or "process"
    if action not in VALID_ACTIONS:
        raise InvalidRequestError(f"Unknown action '{action}'. Use one of: {', '.join(sorted(VALID_ACTIONS))}.")
    if action == "health":
        return {**_health(), "requestId": request_id}

    filename = request.get("fileName")
    if not isinstance(filename, str) or not filename.strip():
        raise InvalidRequestError("fileName is required and must be a non-empty string.")
    filename = _safe_name(filename)

    content = request.get("contentBase64")
    if not isinstance(content, str):
        raise InvalidRequestError("contentBase64 is required and must be a string.")
    # An empty string is valid base64 for an empty file; detect_type raises EMPTY_FILE.
    try:
        data = base64.b64decode(content, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidRequestError("contentBase64 is not valid base64.") from exc

    started = time.perf_counter()
    log.info(f"request action={action} file={filename} bytes={len(data)}")

    # Conversion validates its own extensions/formats (Markdown, HTML, etc.
    # are outside the extraction type map) and 'formats' needs no content.
    if action == "convert":
        options = request.get("options") or {}
        payload = convert.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"convert file={filename} op={payload['operation']} ms={elapsed}")
        return {
            "ok": True,
            "requestId": request_id,
            "fileName": filename,
            "action": action,
            "conversion": payload,
            "processingMs": elapsed,
        }

    # JSON processing validates .json uploads itself (outside the extraction
    # type map) and works without any external binary via the Python fallback.
    if action == "json":
        options = request.get("options") or {}
        payload = jsonproc.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"json file={filename} op={payload['operation']} ms={elapsed}")
        return {
            "ok": True,
            "requestId": request_id,
            "fileName": filename,
            "action": action,
            "json": payload,
            "processingMs": elapsed,
        }

    # Archive processing validates its own compound extensions (.tar.gz etc.)
    # and lists via tarfile without needing the GNU tar binary.
    if action == "archive":
        options = request.get("options") or {}
        payload = archive.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"archive file={filename} op={payload['operation']} ms={elapsed}")
        return {
            "ok": True,
            "requestId": request_id,
            "fileName": filename,
            "action": action,
            "archive": payload,
            "processingMs": elapsed,
        }

    # CLI utilities validate their own extensions (.zip/.gz/.tar.* are outside
    # the extraction type map), 'status' needs no content, and every operation
    # has a Python fallback or an actionable missing-binary message.
    if action == "utils":
        options = request.get("options") or {}
        payload = cliutils.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"utils file={filename} op={payload['operation']} ms={elapsed}")
        return {
            "ok": True,
            "requestId": request_id,
            "fileName": filename,
            "action": action,
            "utils": payload,
            "processingMs": elapsed,
        }

    detected = detector.detect_type(data, filename)
    validation = validator.validate_file(data, filename, request.get("declaredMime"), detected)
    base = {
        "ok": True,
        "requestId": request_id,
        "fileName": filename,
        "action": action,
        "detectedType": detected,
        "validation": validation,
    }

    if action in {"detect", "validate"}:
        base["processingMs"] = round((time.perf_counter() - started) * 1000, 1)
        return base

    if action == "tabular":
        if detected not in {"txt", "csv"}:
            raise UnsupportedTypeError("Tabular analysis supports CSV and TSV text files only.")
        options = request.get("options") or {}
        payload = tabular.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"tabular file={filename} op={payload['operation']} rows={payload['rowCount']} ms={elapsed}")
        return {**base, "tabular": payload, "processingMs": elapsed}

    if action == "spreadsheet":
        if detected not in {"xlsx", "xlsm"}:
            raise UnsupportedTypeError("Spreadsheet analysis supports XLSX and XLSM workbooks only.")
        options = request.get("options") or {}
        payload = spreadsheet.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"spreadsheet file={filename} op={payload['operation']} ms={elapsed}")
        return {**base, "spreadsheet": payload, "processingMs": elapsed}

    if action == "pdf":
        if detected != "pdf":
            raise UnsupportedTypeError("PDF analysis supports PDF documents only.")
        options = request.get("options") or {}
        payload = pdf.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"pdf file={filename} pages={payload['pagesProcessed']}/{payload['pageCount']} ms={elapsed}")
        return {**base, "pdf": payload, "processingMs": elapsed}

    if action == "ocr":
        if detected not in {"image", "pdf"}:
            raise UnsupportedTypeError("OCR supports images (PNG, JPG, TIFF, BMP, GIF, WEBP) and PDF documents.")
        options = request.get("options") or {}
        payload = ocr.analyze(data, filename, options)
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        log.info(f"ocr file={filename} source={payload['sourceType']} ms={elapsed}")
        return {**base, "ocr": payload, "processingMs": elapsed}

    meta = metadata.extract_metadata(data, detected, filename)
    if action == "metadata":
        base.update({"metadata": meta, "processingMs": round((time.perf_counter() - started) * 1000, 1)})
        return base

    if detected == "image":
        raise UnsupportedTypeError("Images are processed with the 'ocr' action, not 'process'.")
    result = get_processor(detected).extract(data)
    text, truncated = clip_text(result.text)
    if not text:
        raise NoTextError("No readable text was found. The file may be scanned, empty or password-protected.")

    meta.update(result.details)
    elapsed = round((time.perf_counter() - started) * 1000, 1)
    log.info(f"processed file={filename} type={detected} chars={len(text)} ms={elapsed}")
    return {
        **base,
        "metadata": meta,
        "text": text,
        "charactersExtracted": len(text),
        "truncated": truncated,
        "warnings": validation["warnings"] + result.warnings,
        "processingMs": elapsed,
    }