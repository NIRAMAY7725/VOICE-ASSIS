"""Tar archive inspection and controlled extraction via GNU Tar.

Listing uses Python's read-only tarfile module (never extracts, works without
any binary). Extraction runs GNU tar on an explicit, validated member list.

Security model:
- Member names are checked before extraction: no absolute paths, no "..",
  no drive letters, no backslashes, no leading "-" (option injection), and
  symlinks/hardlinks/special files are refused outright.
- Extraction goes into a fresh per-request UUID directory under a controlled
  temp root, with --no-same-owner --no-same-permissions, a subprocess timeout,
  and a post-extraction containment check (every path must resolve inside).
- Extracted files are only ever written as bytes — never executed.
- Member count, declared uncompressed size, selected extraction size and
  archive age are all capped.
"""

import io
import lzma
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid
import zlib
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .config import (
    ARCHIVE_TEMP_DIRNAME,
    ARCHIVE_TTL_SECONDS,
    MAX_ARCHIVE_MEMBERS,
    MAX_ARCHIVE_TOTAL_BYTES,
    MAX_EXTRACT_MEMBERS,
    MAX_EXTRACT_TOTAL_BYTES,
    MAX_FILE_BYTES,
    TAR_TIMEOUT_SECONDS,
)
from .errors import (
    ArchiveLimitError,
    CorruptFileError,
    DependencyMissingError,
    EmptyFileError,
    ExtractionError,
    FileTooLargeError,
    InvalidRequestError,
    UnsupportedTypeError,
)
from .logging_setup import configure

log = configure()

TAR_INSTALL_HINT = (
    "GNU Tar is not installed or not on PATH. Note: the tar.exe in "
    "C:\\Windows\\System32 is bsdtar, not GNU tar. Windows options: install Git "
    "for Windows (bundles GNU tar at C:\\Program Files\\Git\\usr\\bin\\tar.exe) "
    "or MSYS2, or set MAYA_TAR_CMD to the full path of a GNU tar.exe in "
    "backend/.env, then restart the server. Archive listing works without GNU tar."
)
WINDOWS_TAR_PATHS = (
    r"C:\Program Files\Git\usr\bin\tar.exe",
    r"C:\Program Files (x86)\Git\usr\bin\tar.exe",
    r"C:\Windows\System32\tar.exe",
)

ARCHIVE_EXTENSIONS = {
    ".tar": "tar",
    ".tar.gz": "gzip",
    ".tgz": "gzip",
    ".tar.bz2": "bzip2",
    ".tbz2": "bzip2",
    ".tbz": "bzip2",
    ".tar.xz": "xz",
    ".txz": "xz",
}


def _is_gnu_tar(command):
    try:
        result = subprocess.run([command, "--version"], shell=False, capture_output=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and b"GNU tar" in result.stdout


def _tar_cmd():
    candidates = []
    override = os.environ.get("MAYA_TAR_CMD")
    if override:
        candidates.append(override)
    found = shutil.which("tar")
    if found:
        candidates.append(found)
    candidates.extend(path for path in WINDOWS_TAR_PATHS if os.path.isfile(path))
    for candidate in candidates:
        if _is_gnu_tar(candidate):
            return candidate
    return None


def available() -> bool:
    """Health probe: True only if a genuine GNU Tar binary actually runs."""
    return _tar_cmd() is not None


def _archive_format(filename):
    lowered = filename.lower()
    for extension, compression in ARCHIVE_EXTENSIONS.items():
        if lowered.endswith(extension):
            return compression
    raise UnsupportedTypeError(
        "Archive processing accepts .tar, .tar.gz, .tgz, .tar.bz2, .tbz2, .tbz, .tar.xz or .txz files."
    )


# Truncated/corrupt compressed streams surface as different exceptions
# depending on the codec (gzip: EOFError/BadGzipFile, xz: LZMAError, ...).
_CORRUPT_ERRORS = (tarfile.TarError, EOFError, OSError, lzma.LZMAError, zlib.error)


def _open_tar(data):
    try:
        return tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
    except _CORRUPT_ERRORS as exc:
        raise CorruptFileError(f"Invalid or corrupted tar archive: {exc}") from exc


def _collect_members(archive):
    members = []
    total = 0
    try:
        for member in archive:
            if len(members) >= MAX_ARCHIVE_MEMBERS:
                raise ArchiveLimitError(f"Archive has too many entries (limit {MAX_ARCHIVE_MEMBERS}).")
            total += member.size
            if total > MAX_ARCHIVE_TOTAL_BYTES:
                raise ArchiveLimitError(
                    f"Archive expands beyond the {MAX_ARCHIVE_TOTAL_BYTES // (1024 * 1024)} MB uncompressed limit."
                )
            members.append(member)
    except _CORRUPT_ERRORS as exc:
        raise CorruptFileError(f"Invalid or corrupted tar archive (truncated): {exc}") from exc
    return members, total


def _member_type(member):
    if member.isdir():
        return "directory"
    if member.isreg():
        return "file"
    if member.issym():
        return "symlink"
    if member.islnk():
        return "hardlink"
    return "special"


def _member_info(member):
    info = {
        "name": member.name,
        "type": _member_type(member),
        "sizeBytes": member.size,
        "mode": oct(member.mode),
    }
    try:
        info["modified"] = datetime.fromtimestamp(member.mtime, tz=timezone.utc).isoformat(timespec="seconds")
    except (ValueError, OSError, OverflowError):
        info["modified"] = None
    if member.uname:
        info["owner"] = member.uname
    if member.gname:
        info["group"] = member.gname
    if member.issym() or member.islnk():
        info["linkTarget"] = member.linkname
    return info


def _list_payload(data, compression):
    with _open_tar(data) as archive:
        members, total = _collect_members(archive)
    return {
        "operation": "list",
        "compression": compression,
        "memberCount": len(members),
        "totalBytes": total,
        "members": [_member_info(member) for member in members],
    }


def _validate_member_name(name):
    if not name or name.startswith("-"):
        raise InvalidRequestError(f"Refusing to extract unsafe member name '{name}'.")
    if "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise InvalidRequestError(f"Refusing to extract '{name}': absolute paths are not allowed.")
    if any(part == ".." for part in PurePosixPath(name).parts):
        raise InvalidRequestError(f"Refusing to extract '{name}': path traversal is not allowed.")
    if any(ord(char) < 32 for char in name):
        raise InvalidRequestError(f"Refusing to extract '{name}': control characters are not allowed.")


def _temp_root():
    root = Path(tempfile.gettempdir()) / ARCHIVE_TEMP_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _cleanup_old_dirs(root):
    cutoff = time.time() - ARCHIVE_TTL_SECONDS
    for entry in root.iterdir():
        try:
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _extract_payload(data, options):
    requested = options.get("members")
    if not isinstance(requested, list) or not requested or not all(isinstance(name, str) for name in requested):
        raise InvalidRequestError("'members' must be a non-empty list of archive member names.")
    if len(requested) > MAX_EXTRACT_MEMBERS:
        raise InvalidRequestError(f"Extract at most {MAX_EXTRACT_MEMBERS} members per request.")
    requested = list(dict.fromkeys(requested))

    with _open_tar(data) as archive:
        members, _ = _collect_members(archive)
    by_name = {member.name: member for member in members}
    missing = [name for name in requested if name not in by_name]
    if missing:
        raise InvalidRequestError(f"Not found in archive: {', '.join(missing[:5])}.")

    selected = []
    total = 0
    for name in requested:
        _validate_member_name(name)
        member = by_name[name]
        if not member.isreg() and not member.isdir():
            raise InvalidRequestError(
                f"Refusing to extract '{name}': {_member_type(member)} entries are never extracted."
            )
        total += member.size
        selected.append(member)
    if total > MAX_EXTRACT_TOTAL_BYTES:
        raise ArchiveLimitError(
            f"Selected files exceed the {MAX_EXTRACT_TOTAL_BYTES // (1024 * 1024)} MB extraction limit."
        )

    command = _tar_cmd()
    if not command:
        raise DependencyMissingError(TAR_INSTALL_HINT)

    root = _temp_root()
    _cleanup_old_dirs(root)
    work_dir = root / uuid.uuid4().hex
    dest = work_dir / "extracted"
    dest.mkdir(parents=True)
    archive_path = work_dir / "archive.tar"
    archive_path.write_bytes(data)

    # --force-local: MSYS2 tar (Git for Windows) otherwise reads "C:\..." as
    # a remote-host spec because of the drive colon. Forward-slash paths avoid
    # MSYS2's backslash mangling in -C arguments.
    args = [
        command, "-xf", archive_path.as_posix(), "-C", dest.as_posix(),
        "--no-same-owner", "--no-same-permissions", "--force-local", *requested,
    ]
    try:
        result = subprocess.run(args, shell=False, capture_output=True, timeout=TAR_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise ExtractionError(f"GNU tar timed out after {TAR_TIMEOUT_SECONDS} seconds.") from exc
    except OSError as exc:
        raise DependencyMissingError(f"GNU tar could not be started: {str(exc)[:200]}. {TAR_INSTALL_HINT}") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ExtractionError(f"GNU tar extraction failed: {detail[:300] or 'unknown error'}")

    # Defense in depth: nothing may exist outside the fresh extraction dir.
    dest_resolved = dest.resolve()
    extracted = []
    extracted_total = 0
    for path in sorted(dest.rglob("*")):
        if not path.resolve().is_relative_to(dest_resolved):
            shutil.rmtree(work_dir, ignore_errors=True)
            raise ExtractionError("Extraction escaped the target directory; output was discarded.")
        if path.is_file():
            size = path.stat().st_size
            extracted_total += size
            extracted.append({
                "name": path.relative_to(dest).as_posix(),
                "type": "file",
                "sizeBytes": size,
            })
        elif path.is_dir():
            extracted.append({"name": path.relative_to(dest).as_posix(), "type": "directory", "sizeBytes": 0})
    if extracted_total > MAX_EXTRACT_TOTAL_BYTES:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise ExtractionError("Extracted data exceeds the size limit; output was discarded.")
    return {
        "operation": "extract",
        "memberCount": len(extracted),
        "totalBytes": extracted_total,
        "outputDir": str(dest),
        "extracted": extracted,
    }


def analyze(data: bytes, filename: str, options=None) -> dict:
    """List or selectively extract a tar archive; return a JSON-serializable payload."""
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "list")
    if operation not in {"list", "extract"}:
        raise InvalidRequestError("Unknown archive operation. Use 'list' or 'extract'.")
    compression = _archive_format(filename)
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise FileTooLargeError(f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB size limit.")
    if operation == "list":
        return _list_payload(data, compression)
    return _extract_payload(data, options)