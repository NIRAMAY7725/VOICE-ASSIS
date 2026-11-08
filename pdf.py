"""pypdf/PdfReader page-wise extraction with document metadata.

Pages are processed lazily one at a time (PdfReader streams page objects),
bounded by a page cap and a per-page character cap. Page numbers are 1-based
and always reflect the document's physical order. Scanned/image-only PDFs
are reported honestly: pages without text are flagged, and a fully textless
PDF raises NO_TEXT instead of pretending extraction succeeded. The combined
fullText (with [Page N] markers) is ready to hand to an AI summarizer.
"""

import datetime as dt
import io

from .config import MAX_PDF_PAGES, MAX_PDF_PAGE_CHARS, MAX_TEXT_CHARS
from .errors import (
    CorruptFileError,
    DependencyMissingError,
    EmptyFileError,
    EncryptedFileError,
    InvalidRequestError,
    NoTextError,
)
from .processors.base import clip_text

METADATA_FIELDS = (
    ("title", "title"),
    ("author", "author"),
    ("subject", "subject"),
    ("creator", "creator"),
    ("producer", "producer"),
)
DATE_FIELDS = (("creationDate", "creation_date"), ("modificationDate", "modification_date"))


def _open_reader(data):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise DependencyMissingError("pypdf is not installed. Run: pip install -r requirements.txt") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise CorruptFileError(f"Could not read the PDF (it may be corrupted): {str(exc)[:200]}") from exc
    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception:
            unlocked = False
        if not unlocked:
            raise EncryptedFileError("The PDF is password-protected. Remove the password and upload it again.")
    try:
        page_count = len(reader.pages)
    except Exception as exc:
        raise CorruptFileError(f"Could not read the PDF pages (it may be corrupted): {str(exc)[:200]}") from exc
    return reader, page_count


def _document_metadata(reader):
    try:
        info = reader.metadata
    except Exception:
        return {}
    if not info:
        return {}
    fields = {}
    for key, attribute in METADATA_FIELDS:
        value = getattr(info, attribute, None)
        if value:
            fields[key] = str(value)
    for key, attribute in DATE_FIELDS:
        value = getattr(info, attribute, None)
        if value:
            fields[key] = value.isoformat() if isinstance(value, dt.datetime) else str(value)
    return fields


def _selected_pages(options, page_count):
    selection = options.get("pages")
    if selection is None:
        limit = min(page_count, MAX_PDF_PAGES)
        return list(range(1, limit + 1)), page_count > MAX_PDF_PAGES
    if not isinstance(selection, list) or not selection:
        raise InvalidRequestError("'pages' must be a non-empty list of 1-based page numbers.")
    if not all(isinstance(number, int) and not isinstance(number, bool) for number in selection):
        raise InvalidRequestError("'pages' must contain only integer page numbers.")
    invalid = [number for number in selection if not 1 <= number <= page_count]
    if invalid:
        raise InvalidRequestError(f"Page numbers out of range (1-{page_count}): {invalid}.")
    if len(selection) > MAX_PDF_PAGES:
        raise InvalidRequestError(f"Select at most {MAX_PDF_PAGES} pages per request.")
    return sorted(set(selection)), False


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Extract page-wise content and return a JSON-serializable payload."""
    if not data:
        raise EmptyFileError("The uploaded PDF is empty.")
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "extract")
    if operation != "extract":
        raise InvalidRequestError(f"Unknown operation '{operation}'. The PDF module supports 'extract'.")

    reader, page_count = _open_reader(data)
    if page_count == 0:
        raise EmptyFileError("The PDF contains no pages.")

    numbers, page_cap_reached = _selected_pages(options, page_count)
    warnings = []
    if page_cap_reached:
        warnings.append(f"Only the first {MAX_PDF_PAGES} of {page_count} pages were processed.")

    pages = []
    scanned_pages = []
    for number in numbers:
        try:
            text = (reader.pages[number - 1].extract_text() or "").strip()
        except Exception as exc:
            text = ""
            warnings.append(f"Page {number} could not be extracted: {str(exc)[:120]}")
        page_truncated = len(text) > MAX_PDF_PAGE_CHARS
        if page_truncated:
            text = text[:MAX_PDF_PAGE_CHARS]
            warnings.append(f"Page {number} text exceeded {MAX_PDF_PAGE_CHARS} characters and was clipped.")
        if not text:
            scanned_pages.append(number)
        pages.append({
            "pageNumber": number,
            "characters": len(text),
            "hasText": bool(text),
            "truncated": page_truncated,
            "text": text,
        })

    if not any(page["hasText"] for page in pages):
        raise NoTextError(
            "No extractable text was found. This PDF appears to be scanned or image-only; "
            "OCR would be required to read it."
        )
    if scanned_pages:
        warnings.append(f"Pages without extractable text (possibly scanned): {scanned_pages}.")

    combined = "\n\n".join(f"[Page {page['pageNumber']}]\n{page['text']}" for page in pages if page["hasText"])
    full_text, text_truncated = clip_text(combined)
    if text_truncated:
        warnings.append(f"Combined text exceeded {MAX_TEXT_CHARS} characters and was clipped for AI use.")

    return {
        "operation": operation,
        "pageCount": page_count,
        "pagesProcessed": len(pages),
        "pages": pages,
        "scannedPages": scanned_pages,
        "metadata": _document_metadata(reader),
        "fullText": full_text,
        "totalCharacters": len(full_text),
        "truncated": page_cap_reached or text_truncated or any(page["truncated"] for page in pages),
        "warnings": warnings,
    }