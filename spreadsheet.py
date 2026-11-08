"""OpenPyXL workbook analysis: summary, values, inspect.

Safety: workbooks are opened with keep_vba=False, so VBA macros from .xlsm
files are discarded and never executed. Formulas are read as strings, never
evaluated. Values/summaries use read-only streaming mode; detailed inspection
(normal mode, needed for merged cells and styles) is guarded by a cell-count
limit. File-level encrypted workbooks (OLE container) are rejected up front.
"""

import datetime as dt
import io
import math
import zipfile

from .config import (
    EXCEL_SAMPLE_ROWS,
    MAX_EXCEL_RESULT_COLS,
    MAX_EXCEL_RESULT_ROWS,
    MAX_FORMULA_CELLS,
    MAX_INSPECT_CELLS,
    MAX_ROWS_PER_SHEET,
    MAX_SHEETS,
    MAX_STYLED_CELLS,
)
from .errors import (
    CorruptFileError,
    DependencyMissingError,
    EmptyFileError,
    EncryptedFileError,
    InvalidRequestError,
)

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
OPERATIONS = {"summary", "values", "inspect"}


def _load_workbook(data, *, read_only, data_only):
    try:
        from openpyxl import load_workbook
        from openpyxl.utils.exceptions import InvalidFileException
    except ImportError as exc:
        raise DependencyMissingError("openpyxl is not installed. Run: pip install -r requirements.txt") from exc
    try:
        return load_workbook(io.BytesIO(data), read_only=read_only, data_only=data_only, keep_vba=False)
    except zipfile.BadZipFile as exc:
        raise CorruptFileError("The workbook is not a valid XLSX/XLSM container (corrupted ZIP).") from exc
    except InvalidFileException as exc:
        raise CorruptFileError(f"Invalid workbook: {str(exc)[:200]}") from exc
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise CorruptFileError(f"Could not read the workbook (it may be corrupted): {str(exc)[:200]}") from exc


def _clean_cell(value):
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    return value


def _clean_row(values, column_cap):
    return [_clean_cell(value) for value in values[:column_cap]]


def _select_sheet(workbook, options):
    names = list(workbook.sheetnames)
    sheet = options.get("sheet")
    if sheet is None:
        return workbook[names[0]]
    if isinstance(sheet, int) and not isinstance(sheet, bool):
        if 1 <= sheet <= len(names):
            return workbook[names[sheet - 1]]
        raise InvalidRequestError(f"Sheet index {sheet} is out of range (1-{len(names)}).")
    if isinstance(sheet, str) and sheet in names:
        return workbook[sheet]
    raise InvalidRequestError(f"Unknown sheet '{sheet}'. Available sheets: {', '.join(names)}.")


def _sheet_dimensions(worksheet):
    rows = 0
    columns = 0
    row_limit_reached = False
    for row in worksheet.iter_rows(values_only=True, max_row=MAX_ROWS_PER_SHEET + 1):
        if rows >= MAX_ROWS_PER_SHEET:
            row_limit_reached = True
            break
        rows += 1
        for index, value in enumerate(row):
            if value is not None and index + 1 > columns:
                columns = index + 1
    return rows, columns, row_limit_reached


def _summary(data, options):
    workbook = _load_workbook(data, read_only=True, data_only=True)
    try:
        names = list(workbook.sheetnames)
        sheets = []
        for name in names[:MAX_SHEETS]:
            worksheet = workbook[name]
            rows, columns, row_limit_reached = _sheet_dimensions(worksheet)
            sample = [
                _clean_row(row, MAX_EXCEL_RESULT_COLS)
                for row in worksheet.iter_rows(values_only=True, max_row=EXCEL_SAMPLE_ROWS)
            ]
            sheets.append({
                "name": name,
                "state": worksheet.sheet_state,
                "rowCount": rows,
                "columnCount": columns,
                "rowLimitReached": row_limit_reached,
                "sampleRows": sample,
            })
        security = getattr(workbook, "security", None)
        return {
            "sheetCount": len(names),
            "sheetNames": names,
            "sheets": sheets,
            "sheetsTruncated": len(names) > MAX_SHEETS,
            "structureProtected": bool(getattr(security, "lockStructure", False)),
        }
    finally:
        workbook.close()


def _values(data, options):
    workbook = _load_workbook(data, read_only=True, data_only=True)
    try:
        worksheet = _select_sheet(workbook, options)
        rows = []
        truncated = False
        max_seen_columns = 0
        for row in worksheet.iter_rows(values_only=True, max_row=MAX_EXCEL_RESULT_ROWS + 1):
            if len(rows) >= MAX_EXCEL_RESULT_ROWS:
                truncated = True
                break
            max_seen_columns = max(max_seen_columns, len(row))
            rows.append(_clean_row(row, MAX_EXCEL_RESULT_COLS))
        columns = max((len(row) for row in rows), default=0)
        return {
            "sheet": worksheet.title,
            "rowCount": len(rows),
            "columnCount": columns,
            "rows": rows,
            "truncated": truncated,
            "columnsTruncated": max_seen_columns > MAX_EXCEL_RESULT_COLS,
        }
    finally:
        workbook.close()


def _rgb(color):
    if color is not None and color.type == "rgb" and isinstance(color.rgb, str):
        return color.rgb
    return None


def _inspect(data, options):
    probe = _load_workbook(data, read_only=True, data_only=True)
    try:
        worksheet = _select_sheet(probe, options)
        title = worksheet.title
        rows, columns, _ = _sheet_dimensions(worksheet)
    finally:
        probe.close()

    if rows * columns > MAX_INSPECT_CELLS:
        raise InvalidRequestError(
            f"Sheet '{title}' has ~{rows * columns} cells, beyond the {MAX_INSPECT_CELLS}-cell "
            "inspection limit. Use operation 'summary' or 'values' instead."
        )

    workbook = _load_workbook(data, read_only=False, data_only=False)
    try:
        worksheet = workbook[title]
        merged = [str(rng) for rng in worksheet.merged_cells.ranges]
        formulas = []
        formatting = []
        formula_count = 0
        for row in worksheet.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                if cell.data_type == "f":
                    formula_count += 1
                    if len(formulas) < MAX_FORMULA_CELLS:
                        formulas.append({"cell": cell.coordinate, "formula": str(cell.value)})
                font = cell.font
                fill = cell.fill
                styled = (
                    (cell.number_format and cell.number_format != "General")
                    or font.bold or font.italic
                    or (fill.patternType and fill.patternType != "none")
                )
                if styled and len(formatting) < MAX_STYLED_CELLS:
                    formatting.append({
                        "cell": cell.coordinate,
                        "numberFormat": cell.number_format,
                        "bold": bool(font.bold),
                        "italic": bool(font.italic),
                        "fontColor": _rgb(font.color),
                        "fillColor": _rgb(fill.fgColor) if fill.patternType == "solid" else None,
                    })
        return {
            "sheet": title,
            "rowCount": worksheet.max_row or 0,
            "columnCount": worksheet.max_column or 0,
            "protected": bool(worksheet.protection.sheet),
            "mergedCells": merged,
            "formulaCount": formula_count,
            "formulas": formulas,
            "formulasTruncated": formula_count > MAX_FORMULA_CELLS,
            "formatting": formatting,
        }
    finally:
        workbook.close()


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Run one workbook operation and return a JSON-serializable payload."""
    if not data:
        raise EmptyFileError("The uploaded workbook is empty.")
    if data.startswith(OLE_MAGIC):
        raise EncryptedFileError("The workbook is password-protected. Remove the password and upload it again.")
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "summary")
    if operation not in OPERATIONS:
        raise InvalidRequestError(f"Unknown operation '{operation}'. Use one of: {', '.join(sorted(OPERATIONS))}.")

    handlers = {"summary": _summary, "values": _values, "inspect": _inspect}
    return {"operation": operation, **handlers[operation](data, options)}