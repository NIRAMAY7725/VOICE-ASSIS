"""Command-line utility integration: pdfinfo, pdftotext, pdffonts, unzip, zcat, GNU Tar.

One reusable module manages all six utilities:
- Detection probes env overrides (MAYA_<NAME>_CMD), PATH, then well-known
  Windows locations (Poppler, Git for Windows). Every candidate is verified
  by actually running its version flag, so a broken binary never counts as
  available.
- A single shared runner executes argv lists with shell=False, captures
  stdout and stderr, enforces a timeout (subprocess.run kills the process on
  timeout) and converts failures into typed errors.
- Uploaded bytes are written to a fresh per-request temp file that is only
  ever READ by the utility — uploaded files are never executed.
- When a utility is missing, operations fall back to pure Python (pypdf,
  zipfile, gzip, tarfile) with engine="python-fallback"; pdffonts has no
  fallback and returns an actionable DEPENDENCY_MISSING message.

Windows note: Git for Windows ships zcat as an MSYS shell script that cannot
be spawned directly from Windows Python. The module detects this and uses
Git's real gzip.exe with "-c -d" (identical zcat semantics) instead.
"""

import gzip
import io
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import archive, pdf
from .config import (
    MAX_ARCHIVE_MEMBERS,
    MAX_ARCHIVE_TOTAL_BYTES,
    MAX_EXTRACT_MEMBERS,
    MAX_EXTRACT_TOTAL_BYTES,
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS,
    MAX_ZCAT_OUTPUT_BYTES,
    UTIL_TEMP_DIRNAME,
    UTIL_TIMEOUT_SECONDS,
    UTIL_TTL_SECONDS,
)
from .errors import (
    ArchiveLimitError,
    CliUtilityError,
    CorruptFileError,
    DependencyMissingError,
    EmptyFileError,
    EncryptedFileError,
    FileTooLargeError,
    InvalidRequestError,
    NoTextError,
    UnsupportedTypeError,
)
from .logging_setup import configure

log = configure()

POPPLER_INSTALL_HINT = (
    "Install Poppler for Windows (provides pdfinfo, pdftotext and pdffonts): "
    "winget install --id oschwartz10612.Poppler, then restart the server. "
    "Or set the full path in backend/.env (MAYA_PDFINFO_CMD, MAYA_PDFTOTEXT_CMD, "
    "MAYA_PDFFONTS_CMD). Git for Windows already bundles pdftotext at "
    "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe."
)
UNZIP_INSTALL_HINT = (
    "unzip is not installed or not runnable. It ships with Git for Windows at "
    "C:\\Program Files\\Git\\usr\\bin\\unzip.exe, or install it separately and set "
    "MAYA_UNZIP_CMD in backend/.env, then restart the server. "
    "ZIP listing and extraction work without it via the Python fallback."
)
ZCAT_INSTALL_HINT = (
    "zcat is not installed or not runnable. Git for Windows bundles gzip.exe at "
    "C:\\Program Files\\Git\\usr\\bin\\gzip.exe (used as 'gzip -c -d', identical to "
    "zcat), or set MAYA_ZCAT_CMD in backend/.env, then restart the server. "
    "Reading .gz streams works without it via the Python fallback."
)

GIT_BIN_DIRS = (
    r"C:\Program Files\Git\usr\bin",
    r"C:\Program Files (x86)\Git\usr\bin",
)
GIT_MINGW_DIRS = (
    r"C:\Program Files\Git\mingw64\bin",
    r"C:\Program Files (x86)\Git\mingw64\bin",
)

# name -> (env var, PATH name, extra Windows probe paths, version argv suffix,
#          stream carrying the version banner, install hint)
UTILITIES = {
    "pdfinfo": (
        "MAYA_PDFINFO_CMD", "pdfinfo",
        [rf"{base}\pdfinfo.exe" for base in (r"C:\Program Files\poppler\bin", r"C:\poppler\bin")],
        ["-v"], "stderr", POPPLER_INSTALL_HINT,
    ),
    "pdftotext": (
        "MAYA_PDFTOTEXT_CMD", "pdftotext",
        [rf"{directory}\pdftotext.exe" for directory in GIT_MINGW_DIRS]
        + [rf"{base}\pdftotext.exe" for base in (r"C:\Program Files\poppler\bin", r"C:\poppler\bin")],
        ["-v"], "stderr", POPPLER_INSTALL_HINT,
    ),
    "pdffonts": (
        "MAYA_PDFFONTS_CMD", "pdffonts",
        [rf"{base}\pdffonts.exe" for base in (r"C:\Program Files\poppler\bin", r"C:\poppler\bin")],
        ["-v"], "stderr", POPPLER_INSTALL_HINT,
    ),
    "unzip": (
        "MAYA_UNZIP_CMD", "unzip",
        [rf"{directory}\unzip.exe" for directory in GIT_BIN_DIRS],
        ["-v"], "stdout", UNZIP_INSTALL_HINT,
    ),
}

OPERATIONS = {"status", "pdfinfo", "pdftotext", "pdffonts", "unzip", "zcat", "tar"}
OPERATION_EXTENSIONS = {
    "pdfinfo": (".pdf",),
    "pdftotext": (".pdf",),
    "pdffonts": (".pdf",),
    "unzip": (".zip",),
    "zcat": (".gz", ".gzip", ".z"),
    "tar": tuple(archive.ARCHIVE_EXTENSIONS),
}


def _run_utility(argv, *, input_bytes=None, timeout=UTIL_TIMEOUT_SECONDS, name="utility"):
    """Run one argv list safely; return CompletedProcess or raise a typed error.

    shell=False throughout: arguments are never interpolated into a shell, so
    filenames and member names cannot inject commands. subprocess.run kills
    the child automatically when the timeout expires.
    """
    try:
        return subprocess.run(argv, input=input_bytes, shell=False, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise CliUtilityError(f"{name} timed out after {timeout} seconds and was terminated.") from exc
    except OSError as exc:
        raise CliUtilityError(f"{name} could not be started: {str(exc)[:200]}") from exc


def _version_of(argv_prefix, suffix, stream):
    try:
        result = _run_utility([*argv_prefix, *suffix], timeout=5, name="utility version probe")
    except CliUtilityError:
        return None
    raw = result.stderr if stream == "stderr" else result.stdout
    if not raw.strip() and stream == "stderr":
        raw = result.stdout
    # Xpdf-derived tools (Git's pdftotext) exit 99 after printing -v to stderr;
    # a version banner there proves the binary runs regardless of exit code.
    if result.returncode != 0 and stream != "stderr":
        return None
    for line in raw.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if line:
            return line[:200]
    return None


def _find_utility(name):
    """Return (argv_prefix, path, version) for a runnable utility, else None.

    Candidates are verified by running their version flag; a candidate that
    cannot execute (e.g. an MSYS shell script on Windows) is skipped.
    """
    env_var, which_name, extra_paths, version_args, stream, _hint = UTILITIES[name]
    candidates = []
    override = os.environ.get(env_var)
    if override:
        candidates.append([override])
    found = shutil.which(which_name)
    if found:
        candidates.append([found])
    candidates.extend([path] for path in extra_paths if os.path.isfile(path))
    for argv_prefix in candidates:
        try:
            version = _version_of(argv_prefix, version_args, stream)
        except CliUtilityError:
            continue
        if version:
            return argv_prefix, argv_prefix[-1], version
    return None


def _zcat_gzip_candidates():
    """zcat candidates: a runnable zcat, else Git's gzip.exe used as gzip -c -d.

    Git for Windows ships zcat as a #!/bin/sh script that Windows Python cannot
    spawn; gzip.exe is a real binary with identical decompression semantics.
    """
    candidates = []
    override = os.environ.get("MAYA_ZCAT_CMD")
    if override:
        candidates.append([override])
    found = shutil.which("zcat")
    if found:
        candidates.append([found])
    candidates.extend([rf"{directory}\zcat.exe"] for directory in GIT_BIN_DIRS)
    runnable = []
    for argv_prefix in candidates:
        if not os.path.isfile(argv_prefix[0]) and not shutil.which(argv_prefix[0]):
            continue
        try:
            version = _version_of(argv_prefix, ["--version"], "stdout")
        except CliUtilityError:
            continue
        if version:
            runnable.append((argv_prefix, argv_prefix[-1], version))
    if runnable:
        return runnable[0]
    for directory in GIT_BIN_DIRS:
        gzip_path = rf"{directory}\gzip.exe"
        if not os.path.isfile(gzip_path):
            continue
        try:
            version = _version_of([gzip_path], ["--version"], "stdout")
        except CliUtilityError:
            continue
        if version:
            return [gzip_path, "-c", "-d"], gzip_path, version
    gzip_found = shutil.which("gzip")
    if gzip_found:
        try:
            version = _version_of([gzip_found], ["--version"], "stdout")
        except CliUtilityError:
            version = None
        if version:
            return [gzip_found, "-c", "-d"], gzip_found, version
    return None


def available(name) -> bool:
    """Health probe: True only if the named utility actually runs."""
    if name == "zcat":
        return _zcat_gzip_candidates() is not None
    if name == "tar":
        return archive.available()
    return _find_utility(name) is not None


def status() -> dict:
    """Detect every utility and report availability, version and path."""
    utilities = {}
    for name in ("pdfinfo", "pdftotext", "pdffonts", "unzip"):
        found = _find_utility(name)
        utilities[name] = (
            {"available": True, "version": found[2], "path": found[1]}
            if found else {"available": False, "version": None, "path": None}
        )
    zcat = _zcat_gzip_candidates()
    utilities["zcat"] = (
        {"available": True, "version": zcat[2], "path": zcat[1]}
        if zcat else {"available": False, "version": None, "path": None}
    )
    tar_command = archive._tar_cmd()
    tar_version = None
    if tar_command:
        try:
            tar_version = _version_of([tar_command], ["--version"], "stdout")
        except CliUtilityError:
            tar_version = "GNU tar"
    utilities["tar"] = (
        {"available": True, "version": tar_version, "path": tar_command}
        if tar_command else {"available": False, "version": None, "path": None}
    )
    return {"operation": "status", "utilities": utilities}


def _temp_root():
    root = Path(tempfile.gettempdir()) / UTIL_TEMP_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _cleanup_old_dirs(root):
    cutoff = time.time() - UTIL_TTL_SECONDS
    for entry in root.iterdir():
        try:
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _work_dir(extension):
    root = _temp_root()
    _cleanup_old_dirs(root)
    work_dir = root / uuid.uuid4().hex
    work_dir.mkdir()
    return work_dir, work_dir / f"input{extension}"


def _check_failure(result, name):
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise CliUtilityError(f"{name} failed: {detail[:300] or 'unknown error'}")


def _decode_output(raw):
    text = raw.decode("utf-8", errors="replace")
    truncated = len(text) > MAX_TEXT_CHARS
    return text[:MAX_TEXT_CHARS], truncated


def _pdfinfo_python(data):
    reader, page_count = pdf._open_reader(data)
    return {
        "pageCount": page_count,
        "metadata": pdf._document_metadata(reader),
        "encrypted": False,
    }


def _pdfinfo(data, filename):
    found = _find_utility("pdfinfo")
    if not found:
        payload = _pdfinfo_python(data)
        return {"operation": "pdfinfo", "engine": "python-fallback",
                "note": "pdfinfo is not installed; metadata came from pypdf.", **payload}
    argv_prefix, _path, version = found
    work_dir, input_path = _work_dir(".pdf")
    try:
        input_path.write_bytes(data)
        # Empty stdin: password-protected PDFs must fail fast, never prompt.
        result = _run_utility([*argv_prefix, str(input_path)], input_bytes=b"", name="pdfinfo")
        _check_failure(result, "pdfinfo")
        fields = {}
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                fields[key.strip()] = value.strip()
        page_count = None
        match = re.search(r"\d+", fields.get("Pages", ""))
        if match:
            page_count = int(match.group())
        return {
            "operation": "pdfinfo", "engine": "pdfinfo", "version": version,
            "pageCount": page_count, "fields": fields,
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _pdftotext(data, filename, options):
    layout = options.get("layout", False)
    if not isinstance(layout, bool):
        raise InvalidRequestError("'layout' must be a boolean.")
    found = _find_utility("pdftotext")
    if not found:
        payload = pdf.analyze(data, filename)
        return {
            "operation": "pdftotext", "engine": "python-fallback",
            "note": "pdftotext is not installed; text came from pypdf.",
            "pageCount": payload["pageCount"], "text": payload["fullText"],
            "totalCharacters": payload["totalCharacters"], "truncated": payload["truncated"],
        }
    argv_prefix, _path, version = found
    work_dir, input_path = _work_dir(".pdf")
    try:
        input_path.write_bytes(data)
        args = [*argv_prefix]
        if layout:
            args.append("-layout")
        # "-" writes extracted text to stdout instead of a sibling file.
        args.extend([str(input_path), "-"])
        result = _run_utility(args, input_bytes=b"", name="pdftotext")
        _check_failure(result, "pdftotext")
        text, truncated = _decode_output(result.stdout)
        if not text.strip():
            raise NoTextError(
                "pdftotext found no extractable text. The PDF may be scanned; use the OCR route."
            )
        return {
            "operation": "pdftotext", "engine": "pdftotext", "version": version,
            "layout": layout, "text": text, "totalCharacters": len(text), "truncated": truncated,
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


_FONT_COLUMNS = ("name", "type", "encoding", "embedded", "subset", "unicode", "objectID", "generation")


def _parse_font_table(stdout):
    lines = [line for line in stdout.decode("utf-8", errors="replace").splitlines() if line.strip()]
    fonts = []
    for line in lines[2:]:  # header row + dashed separator
        parts = line.split()
        if len(parts) < 7:
            continue
        entry = dict(zip(_FONT_COLUMNS[:6], parts[:6]))
        if len(parts) >= 8:
            entry["objectID"] = parts[-2]
            entry["generation"] = parts[-1]
        fonts.append(entry)
    return fonts


def _pdffonts(data, filename):
    found = _find_utility("pdffonts")
    if not found:
        raise DependencyMissingError(f"pdffonts has no Python fallback. {POPPLER_INSTALL_HINT}")
    argv_prefix, _path, version = found
    work_dir, input_path = _work_dir(".pdf")
    try:
        input_path.write_bytes(data)
        result = _run_utility([*argv_prefix, str(input_path)], input_bytes=b"", name="pdffonts")
        _check_failure(result, "pdffonts")
        fonts = _parse_font_table(result.stdout)
        return {
            "operation": "pdffonts", "engine": "pdffonts", "version": version,
            "fontCount": len(fonts), "fonts": fonts,
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _zip_datetime(value):
    try:
        return datetime(*value).replace(tzinfo=timezone.utc).isoformat(timespec="seconds")
    except (ValueError, TypeError):
        return None


def _zip_members(infos):
    members = []
    total = 0
    for info in infos:
        if len(members) >= MAX_ARCHIVE_MEMBERS:
            raise ArchiveLimitError(f"Archive has too many entries (limit {MAX_ARCHIVE_MEMBERS}).")
        total += info.file_size
        if total > MAX_ARCHIVE_TOTAL_BYTES:
            raise ArchiveLimitError(
                f"Archive expands beyond the {MAX_ARCHIVE_TOTAL_BYTES // (1024 * 1024)} MB uncompressed limit."
            )
        members.append({
            "name": info.filename,
            "type": "directory" if info.is_dir() else "file",
            "sizeBytes": info.file_size,
            "compressedBytes": info.compress_size,
            "modified": _zip_datetime(info.date_time),
            "crc": f"{info.CRC:08x}",
        })
    return members, total


def _open_zip(data):
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise CorruptFileError(f"Invalid or corrupted ZIP archive: {exc}") from exc


def _zip_list(data):
    with _open_zip(data) as archive_file:
        members, total = _zip_members(archive_file.infolist())
    return {"memberCount": len(members), "totalBytes": total, "members": members}


def _is_zip_symlink(info):
    return ((info.external_attr >> 16) & 0o170000) == 0o120000


def _validate_zip_selection(infos, requested):
    by_name = {info.filename: info for info in infos}
    missing = [name for name in requested if name not in by_name]
    if missing:
        raise InvalidRequestError(f"Not found in archive: {', '.join(missing[:5])}.")
    selected = []
    total = 0
    for name in requested:
        archive._validate_member_name(name)
        info = by_name[name]
        if _is_zip_symlink(info):
            raise InvalidRequestError(f"Refusing to extract '{name}': symlink entries are never extracted.")
        total += info.file_size
        selected.append(info)
    if total > MAX_EXTRACT_TOTAL_BYTES:
        raise ArchiveLimitError(
            f"Selected files exceed the {MAX_EXTRACT_TOTAL_BYTES // (1024 * 1024)} MB extraction limit."
        )
    return selected


def _unzip_list(data, filename):
    found = _find_utility("unzip")
    if not found:
        return {"operation": "unzip", "engine": "python-fallback",
                "note": "unzip is not installed; listing came from Python's zipfile.",
                **_zip_list(data)}
    argv_prefix, _path, version = found
    work_dir, input_path = _work_dir(".zip")
    try:
        input_path.write_bytes(data)
        result = _run_utility([*argv_prefix, "-l", str(input_path)], input_bytes=b"", name="unzip")
        _check_failure(result, "unzip")
        listing, truncated = _decode_output(result.stdout)
        return {
            "operation": "unzip", "engine": "unzip", "version": version,
            "listing": listing, "truncated": truncated, **_zip_list(data),
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _unzip_extract(data, filename, options):
    requested = options.get("members")
    if not isinstance(requested, list) or not requested or not all(isinstance(name, str) for name in requested):
        raise InvalidRequestError("'members' must be a non-empty list of archive member names.")
    if len(requested) > MAX_EXTRACT_MEMBERS:
        raise InvalidRequestError(f"Extract at most {MAX_EXTRACT_MEMBERS} members per request.")
    requested = list(dict.fromkeys(requested))

    with _open_zip(data) as archive_file:
        infos = archive_file.infolist()
    _zip_members(infos)  # enforce count/size caps before anything else
    selected = _validate_zip_selection(infos, requested)

    found = _find_utility("unzip")
    root = _temp_root()
    _cleanup_old_dirs(root)
    work_dir = root / uuid.uuid4().hex
    dest = work_dir / "extracted"
    dest.mkdir(parents=True)
    input_path = work_dir / "input.zip"
    input_path.write_bytes(data)
    engine = "python-fallback"
    version = None

    if found:
        argv_prefix, _path, version = found
        # No "--" separator: Info-ZIP 6.00 treats it as a filename pattern.
        # Safe because member names are validated to never start with "-".
        result = _run_utility(
            [*argv_prefix, "-o", str(input_path), "-d", str(dest), *requested],
            input_bytes=b"", name="unzip",
        )
        _check_failure(result, "unzip")
        engine = "unzip"
    else:
        try:
            with _open_zip(data) as archive_file:
                for info in selected:
                    # zipfile.extract sanitizes absolute/traversal paths itself;
                    # the containment check below is the authoritative guard.
                    archive_file.extract(info, dest)
        except RuntimeError as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise EncryptedFileError("The ZIP archive is password-protected.") from exc
        log.info("unzip unavailable; extracted via zipfile fallback")

    dest_resolved = dest.resolve()
    extracted = []
    extracted_total = 0
    for path in sorted(dest.rglob("*")):
        if not path.resolve().is_relative_to(dest_resolved):
            shutil.rmtree(work_dir, ignore_errors=True)
            raise CliUtilityError("Extraction escaped the target directory; output was discarded.")
        if path.is_file():
            size = path.stat().st_size
            extracted_total += size
            extracted.append({"name": path.relative_to(dest).as_posix(), "type": "file", "sizeBytes": size})
        elif path.is_dir():
            extracted.append({"name": path.relative_to(dest).as_posix(), "type": "directory", "sizeBytes": 0})
    if extracted_total > MAX_EXTRACT_TOTAL_BYTES:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise CliUtilityError("Extracted data exceeds the size limit; output was discarded.")
    payload = {
        "operation": "unzip", "engine": engine,
        "memberCount": len(extracted), "totalBytes": extracted_total,
        "outputDir": str(dest), "extracted": extracted,
    }
    if version:
        payload["version"] = version
    else:
        payload["note"] = "unzip is not installed; extraction used Python's zipfile."
    return payload


def _zcat_python(data):
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            raw = stream.read(MAX_ZCAT_OUTPUT_BYTES + 1)
    except (OSError, EOFError) as exc:
        raise CorruptFileError(f"Invalid or corrupted gzip stream: {exc}") from exc
    if len(raw) > MAX_ZCAT_OUTPUT_BYTES:
        raise ArchiveLimitError(
            f"Decompressed stream exceeds the {MAX_ZCAT_OUTPUT_BYTES // (1024 * 1024)} MB limit."
        )
    text, truncated = _decode_output(raw)
    return text, truncated


def _zcat(data, filename):
    found = _zcat_gzip_candidates()
    if not found:
        text, truncated = _zcat_python(data)
        return {
            "operation": "zcat", "engine": "python-fallback",
            "note": "zcat is not installed; the stream was read with Python's gzip.",
            "text": text, "totalCharacters": len(text), "truncated": truncated,
        }
    argv_prefix, _path, version = found
    if argv_prefix[-2:] == ["-c", "-d"]:
        args = [*argv_prefix]  # gzip -c -d reads stdin by default
    else:
        args = [*argv_prefix, "-"]
    result = _run_utility(args, input_bytes=data, name="zcat")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise CorruptFileError(f"Invalid or corrupted gzip stream: {detail[:300] or 'decompression failed'}")
    if len(result.stdout) > MAX_ZCAT_OUTPUT_BYTES:
        raise ArchiveLimitError(
            f"Decompressed stream exceeds the {MAX_ZCAT_OUTPUT_BYTES // (1024 * 1024)} MB limit."
        )
    text, truncated = _decode_output(result.stdout)
    return {
        "operation": "zcat", "engine": "zcat", "version": version,
        "text": text, "totalCharacters": len(text), "truncated": truncated,
    }


def _tar(data, filename):
    payload = archive.analyze(data, filename, {"operation": "list"})
    return {**payload, "operation": "tar", "engine": "python-tarfile"}


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Run one utility operation and return a JSON-serializable payload."""
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "status")
    if operation not in OPERATIONS:
        raise InvalidRequestError(
            f"Unknown utility operation '{operation}'. Use one of: {', '.join(sorted(OPERATIONS))}."
        )
    if operation == "status":
        return status()
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise FileTooLargeError(f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB size limit.")
    lowered = filename.lower()
    if not lowered.endswith(OPERATION_EXTENSIONS[operation]):
        raise UnsupportedTypeError(
            f"The '{operation}' operation accepts: {', '.join(OPERATION_EXTENSIONS[operation])}."
        )
    if operation == "pdfinfo":
        return _pdfinfo(data, filename)
    if operation == "pdftotext":
        return _pdftotext(data, filename, options)
    if operation == "pdffonts":
        return _pdffonts(data, filename)
    if operation == "unzip":
        # Parse once up front so corrupt archives fail identically with or
        # without the unzip binary.
        with _open_zip(data):
            pass
        if "members" in options:
            members = options["members"]
            if not isinstance(members, list) or not members or not all(isinstance(name, str) for name in members):
                raise InvalidRequestError("'members' must be a non-empty list of archive member names.")
            return _unzip_extract(data, filename, options)
        return _unzip_list(data, filename)
    if operation == "zcat":
        return _zcat(data, filename)
    return _tar(data, filename)