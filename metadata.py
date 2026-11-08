"""Best-effort structural metadata extraction.

Metadata never blocks processing: if a structural probe fails, the common
metadata is still returned with a warning. File contents are parsed as
data only; no embedded code, macros or formulas are ever executed.
"""

import csv
import hashlib
import io
from pathlib import Path

from .detector import decode_text
from .logging_setup import configure

log = configure()


def _pdf_metadata(data):
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return {"pageCount": len(reader.pages), "encrypted": bool(reader.is_encrypted)}


def _docx_metadata(data):
    from docx import Document

    document = Document(io.BytesIO(data))
    return {"paragraphCount": len(document.paragraphs), "tableCount": len(document.tables)}


def _xlsx_metadata(data):
    from openpyxl import load_workbook

    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        names = list(workbook.sheetnames)
        return {"sheetNames": names, "sheetCount": len(names)}
    finally:
        workbook.close()


def _text_metadata(data, detected_type):
    text, encoding = decode_text(data)
    details = {
        "encoding": encoding,
        "lineCount": text.count("\n") + (1 if text and not text.endswith("\n") else 0),
        "wordCount": len(text.split()),
    }
    if detected_type == "csv":
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
            delimiter = dialect.delimiter
        except csv.Error:
            delimiter = ","
        rows = [row for row in csv.reader(io.StringIO(text), delimiter=delimiter) if row]
        details.update({
            "delimiter": delimiter,
            "rowCount": len(rows),
            "columnCount": max((len(row) for row in rows), default=0),
        })
    return details


def _image_metadata(data):
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        return {"format": image.format, "width": image.width, "height": image.height, "mode": image.mode}


_PROBES = {
    "pdf": _pdf_metadata,
    "docx": _docx_metadata,
    "xlsx": _xlsx_metadata,
    "xlsm": _xlsx_metadata,
    "image": _image_metadata,
}


def extract_metadata(data: bytes, detected_type: str, filename: str) -> dict:
    """Return common metadata plus type-specific structure (best effort)."""
    metadata = {
        "fileName": Path(filename or "").name,
        "sizeBytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "detectedType": detected_type,
    }
    try:
        if detected_type in _PROBES:
            metadata.update(_PROBES[detected_type](data))
        else:
            metadata.update(_text_metadata(data, detected_type))
    except Exception as exc:  # metadata is advisory; processing decides success
        log.warning(f"metadata probe failed for {detected_type}: {exc}")
        metadata["warning"] = "Structural metadata could not be fully extracted."
    return metadata