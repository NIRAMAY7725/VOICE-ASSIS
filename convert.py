"""Document conversion via Pandoc (external binary, never a Python import).

Safety model:
- Pandoc runs through subprocess with a fixed argument list and shell=False.
  Format names are validated against Pandoc's own format lists before they
  ever reach the command line, so no user string is interpreted by a shell.
- Uploads arrive in memory; the only disk writes go into a per-request UUID
  subdirectory of a controlled temp root. Original uploaded files are never
  touched, and output names can never collide with an existing file.
- Old conversion directories are purged on a TTL; output size and runtime
  are capped.
"""

import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from .config import (
    CONVERT_TEMP_DIRNAME,
    CONVERT_TIMEOUT_SECONDS,
    CONVERT_TTL_SECONDS,
    MAX_CONVERT_OUTPUT_BYTES,
    MAX_FILE_BYTES,
)
from .errors import (
    ConversionError,
    DependencyMissingError,
    EmptyFileError,
    FileTooLargeError,
    InvalidRequestError,
    UnsupportedTypeError,
)
from .logging_setup import configure

log = configure()

PANDOC_INSTALL_HINT = (
    "Pandoc is not installed or not on PATH. Windows: run "
    "'winget install --id JohnMacFarlane.Pandoc' (or download the installer from "
    "https://pandoc.org/installing.html), then restart the server. "
    "If it is installed in a custom location, set MAYA_PANDOC_CMD to the full "
    "path of pandoc.exe in backend/.env."
)
WINDOWS_PANDOC_PATHS = (
    r"C:\Program Files\Pandoc\pandoc.exe",
    r"C:\Program Files (x86)\Pandoc\pandoc.exe",
)

# Extension -> Pandoc reader name. Plain text is valid Markdown.
INPUT_FORMATS = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".mdown": "markdown",
    ".txt": "markdown",
    ".html": "html",
    ".htm": "html",
    ".docx": "docx",
    ".rst": "rst",
    ".tex": "latex",
    ".latex": "latex",
    ".odt": "odt",
    ".epub": "epub",
    ".org": "org",
    ".textile": "textile",
}

# Pandoc writer name -> output file extension.
OUTPUT_EXTENSIONS = {
    "markdown": "md",
    "gfm": "md",
    "commonmark": "md",
    "html": "html",
    "html5": "html",
    "html4": "html",
    "plain": "txt",
    "docx": "docx",
    "odt": "odt",
    "epub": "epub",
    "epub3": "epub",
    "rst": "rst",
    "latex": "tex",
    "asciidoc": "adoc",
    "textile": "textile",
    "org": "org",
    "rtf": "rtf",
    "man": "man",
    "ipynb": "ipynb",
}


def _pandoc_cmd():
    command = os.environ.get("MAYA_PANDOC_CMD")
    if command:
        return command
    found = shutil.which("pandoc")
    if found:
        return found
    for candidate in WINDOWS_PANDOC_PATHS:
        if os.path.isfile(candidate):
            return candidate
    return None


def _run_pandoc(args, timeout=CONVERT_TIMEOUT_SECONDS):
    command = _pandoc_cmd()
    if not command:
        raise DependencyMissingError(PANDOC_INSTALL_HINT)
    try:
        return subprocess.run(
            [command, *args],
            shell=False,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise ConversionError(f"Pandoc timed out after {timeout} seconds. Try a smaller document.") from exc
    except OSError as exc:
        raise DependencyMissingError(f"Pandoc could not be started: {str(exc)[:200]}. {PANDOC_INSTALL_HINT}") from exc


def available() -> bool:
    """Health probe: True only if the Pandoc binary actually runs."""
    try:
        result = _run_pandoc(["--version"], timeout=10)
        return result.returncode == 0
    except (DependencyMissingError, ConversionError):
        return False


def _version():
    result = _run_pandoc(["--version"], timeout=10)
    if result.returncode != 0:
        raise DependencyMissingError(f"Pandoc could not report its version. {PANDOC_INSTALL_HINT}")
    first_line = result.stdout.decode("utf-8", errors="replace").splitlines()[0]
    return first_line.strip()


def _list_formats(kind):
    result = _run_pandoc([f"--list-{kind}-formats"], timeout=10)
    if result.returncode != 0:
        raise DependencyMissingError(f"Pandoc could not list {kind} formats. {PANDOC_INSTALL_HINT}")
    return {line.strip() for line in result.stdout.decode("utf-8", errors="replace").splitlines() if line.strip()}


def _formats_payload():
    return {
        "operation": "formats",
        "pandocVersion": _version(),
        "inputFormats": sorted(_list_formats("input")),
        "outputFormats": sorted(_list_formats("output") - {"pdf"}),
        "supportedExtensions": sorted(INPUT_FORMATS),
    }


def _temp_root():
    root = Path(tempfile.gettempdir()) / CONVERT_TEMP_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _cleanup_old_dirs(root):
    cutoff = time.time() - CONVERT_TTL_SECONDS
    for entry in root.iterdir():
        try:
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            continue


def _output_name(filename, output_format):
    stem = Path(filename).stem
    stem = re.sub(r"[^\w.\- ]", "_", stem).strip(" .")[:80] or "converted"
    return f"{stem}.{OUTPUT_EXTENSIONS[output_format]}"


def _convert(data, filename, options):
    extension = Path(filename).suffix.lower()
    if extension not in INPUT_FORMATS:
        raise UnsupportedTypeError(
            f"Conversion does not accept '{extension or 'no extension'}' files. "
            f"Supported: {', '.join(sorted(INPUT_FORMATS))}."
        )
    input_format = INPUT_FORMATS[extension]
    standalone = options.get("standalone", True)
    if not isinstance(standalone, bool):
        raise InvalidRequestError("'standalone' must be a boolean.")

    output_format = options.get("outputFormat")
    installed_output = _list_formats("output")
    if not isinstance(output_format, str) or not output_format.strip():
        raise InvalidRequestError(
            "'outputFormat' is required. Available output formats: "
            f"{', '.join(sorted(installed_output - {'pdf'}))}."
        )
    output_format = output_format.strip().lower()
    if output_format == "pdf":
        raise InvalidRequestError(
            "PDF output requires a LaTeX engine that Pandoc does not bundle. "
            "Convert to HTML or DOCX instead."
        )
    if output_format not in installed_output or output_format not in OUTPUT_EXTENSIONS:
        raise InvalidRequestError(
            f"Unknown or unsupported output format '{output_format}'. Supported: "
            f"{', '.join(sorted(set(OUTPUT_EXTENSIONS) & installed_output))}."
        )
    installed_input = _list_formats("input")
    if input_format not in installed_input:
        raise InvalidRequestError(
            f"The installed Pandoc cannot read '{input_format}'. Available input formats: "
            f"{', '.join(sorted(installed_input))}."
        )

    version = _version()
    root = _temp_root()
    _cleanup_old_dirs(root)
    work_dir = root / uuid.uuid4().hex
    work_dir.mkdir()
    input_path = work_dir / f"input{extension}"
    output_path = work_dir / _output_name(filename, output_format)
    input_path.write_bytes(data)

    args = [str(input_path), "-f", input_format, "-t", output_format, "-o", str(output_path), "--wrap=none"]
    if standalone:
        args.append("--standalone")
    result = _run_pandoc(args)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ConversionError(f"Pandoc could not convert this file: {detail[:300] or 'unknown error'}")
    if not output_path.is_file():
        raise ConversionError("Pandoc reported success but produced no output file.")
    size = output_path.stat().st_size
    if size == 0:
        raise ConversionError("Pandoc produced an empty file. The source document may have no convertible content.")
    if size > MAX_CONVERT_OUTPUT_BYTES:
        raise ConversionError(
            f"Converted file exceeds the {MAX_CONVERT_OUTPUT_BYTES // (1024 * 1024)} MB output limit."
        )
    return {
        "operation": "convert",
        "inputFormat": input_format,
        "outputFormat": output_format,
        "outputFileName": output_path.name,
        "outputPath": str(output_path),
        "sizeBytes": size,
        "pandocVersion": version,
    }


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Convert a document (or list formats) and return a JSON-serializable payload."""
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "convert")
    if operation == "formats":
        return _formats_payload()
    if operation != "convert":
        raise InvalidRequestError("Unknown conversion operation. Use 'convert' or 'formats'.")
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise FileTooLargeError(f"File exceeds the {MAX_FILE_BYTES // (1024 * 1024)} MB size limit.")
    return _convert(data, filename, options)