"""OCR service: pytesseract for images, pypdfium2 rendering for scanned PDFs.

PDF pages that already contain extractable text are NEVER OCR'd (requirement:
no unnecessary OCR). Tesseract is only required when an actual OCR pass is
needed; a missing binary produces a clear, actionable DEPENDENCY_MISSING
error with Windows installation instructions. Images are only decoded and
transformed with Pillow — never executed.
"""

import io
import os
import shutil

from .config import (
    MAX_IMAGE_PIXELS,
    MAX_OCR_PAGES,
    MAX_PDF_PAGE_CHARS,
    MAX_TEXT_CHARS,
    OCR_DEFAULT_DPI,
)
from .errors import (
    CorruptFileError,
    DependencyMissingError,
    InvalidRequestError,
    NoTextError,
    OcrError,
)
from .processors.base import clip_text

TESSERACT_INSTALL_HINT = (
    "Tesseract OCR is not installed or not on PATH. Windows: run "
    "'winget install --id UB-Mannheim.TesseractOCR' (or download the installer from "
    "https://github.com/UB-Mannheim/tesseract/wiki), then restart the server. "
    "If it is installed in a custom location, set MAYA_TESSERACT_CMD to the full "
    "path of tesseract.exe in backend/.env."
)
WINDOWS_TESSERACT_PATHS = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
)
SUPPORTED_IMAGE_FORMATS = {"PNG", "JPEG", "GIF", "BMP", "TIFF", "WEBP", "MPO"}


def _pytesseract():
    try:
        import pytesseract
    except ImportError as exc:
        raise DependencyMissingError("pytesseract is not installed. Run: pip install -r requirements.txt") from exc
    command = os.environ.get("MAYA_TESSERACT_CMD")
    if command:
        pytesseract.pytesseract.tesseract_cmd = command
    elif not shutil.which(pytesseract.pytesseract.tesseract_cmd):
        for candidate in WINDOWS_TESSERACT_PATHS:
            if os.path.isfile(candidate):
                pytesseract.pytesseract.tesseract_cmd = candidate
                break
    return pytesseract


def _require_tesseract():
    pytesseract = _pytesseract()
    try:
        pytesseract.get_tesseract_version()
    except pytesseract.TesseractNotFoundError as exc:
        raise DependencyMissingError(TESSERACT_INSTALL_HINT) from exc
    except Exception as exc:
        raise DependencyMissingError(f"Tesseract could not be started: {str(exc)[:200]}. {TESSERACT_INSTALL_HINT}") from exc
    return pytesseract


def available() -> bool:
    """Health probe: True only if the Tesseract binary actually runs."""
    try:
        _require_tesseract()
        return True
    except DependencyMissingError:
        return False


def _validate_language(pytesseract, language):
    if not isinstance(language, str) or not language.strip():
        raise InvalidRequestError("'language' must be a non-empty string such as 'eng' or 'eng+fra'.")
    requested = [part.strip() for part in language.split("+") if part.strip()]
    try:
        installed = set(pytesseract.get_languages(config=""))
    except Exception as exc:
        raise DependencyMissingError(f"Tesseract language data could not be read: {str(exc)[:150]}") from exc
    missing = [part for part in requested if part not in installed]
    if missing:
        raise InvalidRequestError(
            f"OCR language(s) not installed: {', '.join(missing)}. "
            f"Available: {', '.join(sorted(installed))}. "
            "Install the matching tessdata language pack (Windows installer: choose additional languages)."
        )
    return "+".join(requested)


def _validate_preprocessing(spec):
    if not isinstance(spec, dict):
        raise InvalidRequestError("'preprocessing' must be a JSON object.")
    allowed = {"grayscale", "denoise", "contrast", "upscale", "binarize"}
    unknown = set(spec) - allowed
    if unknown:
        raise InvalidRequestError(f"Unknown preprocessing option(s): {', '.join(sorted(unknown))}.")

    grayscale = spec.get("grayscale", True)
    denoise = spec.get("denoise", False)
    contrast = spec.get("contrast", 1.0)
    upscale = spec.get("upscale", 1)
    binarize = spec.get("binarize")
    if not isinstance(grayscale, bool) or not isinstance(denoise, bool):
        raise InvalidRequestError("'grayscale' and 'denoise' must be booleans.")
    if not isinstance(contrast, (int, float)) or not 0.5 <= contrast <= 3.0:
        raise InvalidRequestError("'contrast' must be a number between 0.5 and 3.0.")
    if not isinstance(upscale, int) or isinstance(upscale, bool) or not 1 <= upscale <= 4:
        raise InvalidRequestError("'upscale' must be an integer between 1 and 4.")
    if binarize is not None and (not isinstance(binarize, int) or isinstance(binarize, bool) or not 0 <= binarize <= 255):
        raise InvalidRequestError("'binarize' must be an integer threshold between 0 and 255.")


def _preprocess(image, spec):
    from PIL import Image, ImageEnhance, ImageFilter

    _validate_preprocessing(spec)
    grayscale = spec.get("grayscale", True)
    denoise = spec.get("denoise", False)
    contrast = spec.get("contrast", 1.0)
    upscale = spec.get("upscale", 1)
    binarize = spec.get("binarize")

    applied = []
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    if grayscale and image.mode != "L":
        image = image.convert("L")
        applied.append("grayscale")
    if denoise:
        image = image.filter(ImageFilter.MedianFilter(3))
        applied.append("denoise")
    if contrast != 1.0:
        image = ImageEnhance.Contrast(image).enhance(float(contrast))
        applied.append(f"contrast x{contrast}")
    if upscale > 1:
        image = image.resize((image.width * upscale, image.height * upscale), Image.LANCZOS)
        applied.append(f"upscale x{upscale}")
    if binarize is not None:
        image = image.convert("L").point(lambda pixel: 255 if pixel > binarize else 0)
        applied.append(f"binarize @{binarize}")
    return image, applied


def _run_ocr(pytesseract, image, language):
    try:
        text = (pytesseract.image_to_string(image, lang=language) or "").strip()
        data = pytesseract.image_to_data(image, lang=language, output_type=pytesseract.Output.DICT)
        scores = [float(value) for value in data["conf"] if float(value) >= 0]
        confidence = round(sum(scores) / len(scores), 1) if scores else None
    except pytesseract.TesseractError as exc:
        raise OcrError(f"Tesseract failed while reading the image: {str(exc)[:200]}") from exc
    return text, confidence


def _open_image(data):
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Image.DecompressionBombError as exc:
        raise InvalidRequestError(f"Image exceeds the {MAX_IMAGE_PIXELS:,}-pixel safety limit.") from exc
    except Exception as exc:
        raise CorruptFileError(f"Could not decode the image (unsupported or corrupted): {str(exc)[:150]}") from exc
    if image.format not in SUPPORTED_IMAGE_FORMATS:
        raise CorruptFileError(f"Unsupported image format '{image.format}'. Use PNG, JPG, TIFF, BMP, GIF or WEBP.")
    return image


def _ocr_image(data, options, language, preprocessing):
    image = _open_image(data)
    width, height, image_format = image.width, image.height, image.format
    processed, applied = _preprocess(image, preprocessing)
    pytesseract = _require_tesseract()
    language = _validate_language(pytesseract, language)
    text, confidence = _run_ocr(pytesseract, processed, language)
    if not text:
        raise NoTextError("OCR found no readable text in this image.")
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS]
    return {
        "sourceType": "image",
        "format": image_format,
        "width": width,
        "height": height,
        "language": language,
        "preprocessing": applied,
        "text": text,
        "characters": len(text),
        "confidence": confidence,
        "warnings": [],
    }


def _ocr_pdf(data, options, language, preprocessing):
    from . import pdf as pdf_module

    reader, page_count = pdf_module._open_reader(data)
    if page_count == 0:
        from .errors import EmptyFileError

        raise EmptyFileError("The PDF contains no pages.")

    dpi = options.get("dpi", OCR_DEFAULT_DPI)
    if not isinstance(dpi, int) or isinstance(dpi, bool) or not 72 <= dpi <= 300:
        raise InvalidRequestError("'dpi' must be an integer between 72 and 300.")
    selection = options.get("pages")
    if selection is None:
        numbers = list(range(1, min(page_count, MAX_OCR_PAGES) + 1))
    else:
        numbers, _ = pdf_module._selected_pages(options, page_count)
        if len(numbers) > MAX_OCR_PAGES:
            raise InvalidRequestError(f"OCR supports at most {MAX_OCR_PAGES} pages per request.")

    warnings = []
    if page_count > MAX_OCR_PAGES and selection is None:
        warnings.append(f"Only the first {MAX_OCR_PAGES} of {page_count} pages were processed.")

    pdfium = None
    pytesseract = None
    validated_language = None
    applied = []
    pages = []
    for number in numbers:
        try:
            existing = (reader.pages[number - 1].extract_text() or "").strip()
        except Exception:
            existing = ""
        confidence = None
        if existing:
            # Requirement: never OCR a page that already has readable text.
            source = "text"
            text = existing
        else:
            if pytesseract is None:
                pytesseract = _require_tesseract()
                validated_language = _validate_language(pytesseract, language)
                import pypdfium2 as pdfium_module

                pdfium = pdfium_module
            try:
                document = pdfium.PdfDocument(data)
                bitmap = document[number - 1].render(scale=dpi / 72)
                rendered = bitmap.to_pil()
                document.close()
            except Exception as exc:
                raise OcrError(f"Could not render PDF page {number} to an image: {str(exc)[:150]}") from exc
            processed, applied = _preprocess(rendered, preprocessing)
            text, confidence = _run_ocr(pytesseract, processed, validated_language)
            source = "ocr"
        if len(text) > MAX_PDF_PAGE_CHARS:
            text = text[:MAX_PDF_PAGE_CHARS]
            warnings.append(f"Page {number} text exceeded {MAX_PDF_PAGE_CHARS} characters and was clipped.")
        pages.append({
            "pageNumber": number,
            "source": source,
            "characters": len(text),
            "text": text,
            **({"confidence": confidence} if source == "ocr" else {}),
        })

    if not any(page["characters"] for page in pages):
        raise NoTextError("Neither text extraction nor OCR found readable content in this PDF.")

    combined = "\n\n".join(f"[Page {page['pageNumber']}]\n{page['text']}" for page in pages if page["characters"])
    full_text, text_truncated = clip_text(combined)
    if text_truncated:
        warnings.append(f"Combined text exceeded {MAX_TEXT_CHARS} characters and was clipped.")
    ocr_pages = sum(1 for page in pages if page["source"] == "ocr")
    return {
        "sourceType": "pdf",
        "pageCount": page_count,
        "pagesProcessed": len(pages),
        "ocrPages": ocr_pages,
        "textPages": len(pages) - ocr_pages,
        "language": validated_language or language,
        "preprocessing": applied,
        "dpi": dpi,
        "pages": pages,
        "fullText": full_text,
        "totalCharacters": len(full_text),
        "truncated": text_truncated or (page_count > MAX_OCR_PAGES and selection is None),
        "warnings": warnings,
    }


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Run OCR (or text reuse) and return a JSON-serializable payload."""
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    language = options.get("language", "eng")
    preprocessing = options.get("preprocessing", {})
    _validate_preprocessing(preprocessing)
    from .detector import detect_type

    detected = detect_type(data, filename)
    if detected == "image":
        payload = _ocr_image(data, options, language, preprocessing)
    elif detected == "pdf":
        payload = _ocr_pdf(data, options, language, preprocessing)
    else:
        from .errors import UnsupportedTypeError

        raise UnsupportedTypeError("OCR supports images (PNG, JPG, TIFF, BMP, GIF, WEBP) and PDF documents.")
    return {"operation": "ocr", **payload}