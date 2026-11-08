"""Validation layer: size, extension, content consistency and MIME advisory.

Hard failures: empty, oversized, unsupported extension, extension/content
mismatch. Soft warnings: txt/csv family ambiguity and browser MIME quirks
(browsers frequently send application/octet-stream, which is ignored).
"""

from pathlib import Path

from .config import MAX_FILE_BYTES
from .detector import EXTENSION_TYPES, IMAGE_MIMES, MIME_TYPES, SPREADSHEET_FAMILY, TEXT_FAMILY, detect_type
from .errors import (
    EmptyFileError,
    FileTooLargeError,
    TypeMismatchError,
    UnsupportedTypeError,
)

IGNORED_MIMES = {"", "application/octet-stream", "binary/octet-stream"}


def validate_file(data: bytes, filename: str, declared_mime=None, detected_type=None):
    """Validate an upload and return a structured validation report."""
    warnings = []
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise FileTooLargeError(
            f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB size limit."
        )

    extension = Path(filename or "").suffix.lower()
    if extension not in EXTENSION_TYPES:
        raise UnsupportedTypeError("Unsupported file type. Use PDF, DOCX, TXT, CSV or XLSX.")

    detected = detected_type or detect_type(data, filename)
    expected = EXTENSION_TYPES[extension]
    if detected != expected:
        if {detected, expected} <= TEXT_FAMILY or {detected, expected} <= SPREADSHEET_FAMILY:
            warnings.append(f"Extension {extension} treated as {detected} based on content.")
        else:
            raise TypeMismatchError(
                f"File extension {extension} does not match its actual content ({detected})."
            )

    mime = (declared_mime or "").split(";")[0].strip().lower()
    expected_mime = IMAGE_MIMES.get(extension) if detected == "image" else MIME_TYPES[detected]
    if mime not in IGNORED_MIMES and expected_mime and mime != expected_mime:
        warnings.append(f"Declared MIME '{mime}' differs from detected '{expected_mime}'.")

    return {
        "extension": extension,
        "detectedType": detected,
        "sizeBytes": len(data),
        "warnings": warnings,
    }