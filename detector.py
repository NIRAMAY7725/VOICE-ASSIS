"""Content-first file type detection.

The browser-supplied extension and MIME type are never trusted on their
own: magic bytes and container structure decide the real type. Uploaded
content is only ever parsed as data — nothing is executed.
"""

import io
import zipfile
from pathlib import Path

from .config import MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES
from .errors import (
    ArchiveLimitError,
    CorruptFileError,
    EmptyFileError,
    EncryptedFileError,
    UnsupportedTypeError,
)

PDF_MAGIC = b"%PDF-"
ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

EXTENSION_TYPES = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".xlsx": "xlsx",
    ".xlsm": "xlsm",
    ".txt": "txt",
    ".csv": "csv",
    ".tsv": "txt",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".jfif": "image",
    ".tif": "image",
    ".tiff": "image",
    ".bmp": "image",
    ".gif": "image",
    ".webp": "image",
}

MIME_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    "txt": "text/plain",
    "csv": "text/csv",
}

TEXT_FAMILY = {"txt", "csv"}
SPREADSHEET_FAMILY = {"xlsx", "xlsm"}

IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _is_image(data: bytes) -> bool:
    if data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"II*\x00", b"MM\x00*")):
        return True
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True
    # BMP's two-byte magic also matches ordinary text, so require the
    # reserved header fields to be zero as real BMP files have them.
    return data[:2] == b"BM" and len(data) > 14 and data[6:10] == b"\x00\x00\x00\x00"


def _looks_binary(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    sample = data[:4096]
    control = sum(1 for byte in sample if byte < 32 and byte not in (9, 10, 13))
    return control / max(len(sample), 1) > 0.10


def decode_text(data: bytes):
    """Decode text bytes, returning (text, encoding). Raises CorruptFileError."""
    # UTF-16 text legitimately contains NUL bytes, so check the BOM first.
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return data.decode("utf-16"), "utf-16"
        except UnicodeDecodeError as exc:
            raise CorruptFileError("File has a UTF-16 BOM but is not valid UTF-16.") from exc
    if _looks_binary(data):
        raise CorruptFileError("File contains binary data; it is not a text document.")
    try:
        return data.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        return data.decode("cp1252"), "cp1252"
    except UnicodeDecodeError as exc:
        raise CorruptFileError("File is not decodable as text.") from exc


def check_zip_limits(data: bytes):
    """Guard DOCX/XLSX containers against zip-bomb style resource abuse."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
    except zipfile.BadZipFile as exc:
        raise CorruptFileError(f"Invalid ZIP container: {exc}") from exc
    if len(infos) > MAX_ZIP_ENTRIES:
        raise ArchiveLimitError(f"ZIP container has too many entries (limit {MAX_ZIP_ENTRIES}).")
    total = sum(info.file_size for info in infos)
    if total > MAX_ZIP_UNCOMPRESSED_BYTES:
        raise ArchiveLimitError("ZIP container expands beyond the safe uncompressed size limit.")


def detect_type(data: bytes, filename: str) -> str:
    """Return the real type: pdf | docx | xlsx | txt | csv."""
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if data.startswith(OLE_MAGIC):
        extension = Path(filename or "").suffix.lower()
        if extension in {".xlsx", ".xlsm", ".xls"}:
            raise EncryptedFileError("The workbook is password-protected. Remove the password and upload it again.")
        raise UnsupportedTypeError("Legacy binary Office files are not supported. Use XLSX, XLSM, DOCX or PDF.")
    if _is_image(data):
        return "image"
    if data.startswith(PDF_MAGIC):
        return "pdf"
    if data.startswith(ZIP_MAGIC):
        check_zip_limits(data)
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = set(archive.namelist())
        except zipfile.BadZipFile as exc:
            raise CorruptFileError(f"Invalid ZIP container: {exc}") from exc
        if "word/document.xml" in names:
            return "docx"
        if "xl/workbook.xml" in names:
            return "xlsm" if "xl/vbaProject.bin" in names else "xlsx"
        raise UnsupportedTypeError("ZIP archive is not a DOCX or XLSX document.")
    decode_text(data)  # raises CorruptFileError for binary payloads
    extension = Path(filename or "").suffix.lower()
    return "csv" if extension == ".csv" else "txt"