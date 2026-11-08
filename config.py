"""Central resource limits shared by validation, detection and processing.

Values mirror the existing Node backend (8 MB upload cap, 120k extracted
characters) so the Python engine never widens the current attack surface.
"""

MAX_FILE_BYTES = 8 * 1024 * 1024          # matches multer fileSize in fileAssistant.js
MAX_TEXT_CHARS = 120_000                  # matches fileExtractor.js MAX_EXTRACTED_CHARS
MAX_PDF_PAGES = 200
MAX_SHEETS = 50
MAX_ROWS_PER_SHEET = 5_000
MAX_ZIP_ENTRIES = 5_000
MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_STDIN_BYTES = 32 * 1024 * 1024        # base64 of an 8 MB file is ~11 MB
MAX_TABULAR_ROWS = 100_000                # pandas parse cap (nrows)
MAX_TABULAR_COLUMNS = 200
MAX_RESULT_ROWS = 1_000                   # rows returned per filter/sort/aggregate
TABULAR_SAMPLE_ROWS = 10                  # sample rows in a profile
MAX_EXCEL_RESULT_ROWS = 1_000             # rows returned by spreadsheet 'values'
MAX_EXCEL_RESULT_COLS = 100               # columns returned per row
MAX_INSPECT_CELLS = 200_000               # normal-mode guard for 'inspect'
MAX_FORMULA_CELLS = 500                   # formula entries returned
MAX_STYLED_CELLS = 200                    # formatting entries returned
EXCEL_SAMPLE_ROWS = 5                     # sample rows per sheet in a summary
MAX_PDF_PAGE_CHARS = 20_000               # per-page text cap in page-wise extraction
MAX_OCR_PAGES = 20                        # OCR is slow: page cap per request
MAX_IMAGE_PIXELS = 40_000_000             # decompression-bomb guard for images
OCR_DEFAULT_DPI = 200                     # PDF page render resolution for OCR
CONVERT_TIMEOUT_SECONDS = 60              # Pandoc subprocess timeout
MAX_CONVERT_OUTPUT_BYTES = 32 * 1024 * 1024  # converted file size cap
CONVERT_TTL_SECONDS = 3600                # age limit for temp conversion dirs
CONVERT_TEMP_DIRNAME = "maya-conversions"  # controlled dir under the system temp
MAX_JSON_DEPTH = 100                      # nesting depth cap for JSON documents
MAX_JSON_NODES = 200_000                  # total values (objects/arrays/scalars) cap
MAX_STRUCTURE_KEYS = 50                   # keys shown per object in structure trees
MAX_STRUCTURE_DEPTH = 6                   # tree levels shown before truncation
JSON_QUERY_TIMEOUT = 5                    # seconds; jq filters can be infinite (repeat)
MAX_QUERY_RESULTS = 1_000                 # values returned by one query
MAX_QUERY_OUTPUT_BYTES = 2 * 1024 * 1024  # jq stdout cap
MAX_ARCHIVE_MEMBERS = 5_000               # entries per tar archive
MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024  # declared uncompressed size cap
MAX_EXTRACT_MEMBERS = 100                 # selected files per extract request
MAX_EXTRACT_TOTAL_BYTES = 32 * 1024 * 1024  # selected extraction size cap
TAR_TIMEOUT_SECONDS = 30                  # GNU tar subprocess timeout
ARCHIVE_TTL_SECONDS = 3600                # age limit for temp archive dirs
ARCHIVE_TEMP_DIRNAME = "maya-archives"    # controlled dir under the system temp
UTIL_TIMEOUT_SECONDS = 30                 # CLI utility subprocess timeout
UTIL_TEMP_DIRNAME = "maya-utils"          # controlled dir for utility inputs
UTIL_TTL_SECONDS = 3600                   # age limit for temp utility dirs
MAX_ZCAT_OUTPUT_BYTES = 64 * 1024 * 1024  # decompressed stream size cap