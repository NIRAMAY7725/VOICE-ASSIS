"""Typed engine exceptions with stable codes for the JSON protocol.

Every error surfaced to the backend is an EngineError carrying a machine
readable code, a safe human message and an HTTP-style status. Unexpected
exceptions are caught at the CLI boundary and converted to a generic
PROCESSING_FAILED response so internals never leak to stdout.
"""


class EngineError(Exception):
    code = "PROCESSING_FAILED"
    status = 500

    def __init__(self, message, *, code=None, status=None):
        super().__init__(message)
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status

    def to_dict(self):
        return {"code": self.code, "message": str(self), "status": self.status}


class InvalidRequestError(EngineError):
    code = "INVALID_REQUEST"
    status = 400


class EmptyFileError(EngineError):
    code = "EMPTY_FILE"
    status = 400


class FileTooLargeError(EngineError):
    code = "FILE_TOO_LARGE"
    status = 413


class UnsupportedTypeError(EngineError):
    code = "UNSUPPORTED_TYPE"
    status = 415


class TypeMismatchError(EngineError):
    code = "TYPE_MISMATCH"
    status = 400


class CorruptFileError(EngineError):
    code = "CORRUPT_FILE"
    status = 400


class EncryptedFileError(EngineError):
    code = "ENCRYPTED_FILE"
    status = 400


class NoTextError(EngineError):
    code = "NO_TEXT"
    status = 400


class ArchiveLimitError(EngineError):
    code = "ARCHIVE_LIMIT"
    status = 400


class DependencyMissingError(EngineError):
    code = "DEPENDENCY_MISSING"
    status = 500


class OcrError(EngineError):
    code = "OCR_FAILED"
    status = 422


class ConversionError(EngineError):
    code = "CONVERSION_FAILED"
    status = 422


class InvalidJsonError(EngineError):
    code = "INVALID_JSON"
    status = 400


class ExtractionError(EngineError):
    code = "EXTRACTION_FAILED"
    status = 422


class CliUtilityError(EngineError):
    code = "UTILITY_FAILED"
    status = 422