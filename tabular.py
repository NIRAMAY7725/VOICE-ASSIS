"""Pandas-powered CSV/TSV analysis: profile, filter, sort, aggregate.

Memory is controlled at three layers: the shared 8 MB upload cap, a hard
row limit while parsing (nrows), and a cap on result rows returned to the
backend. Data is only ever parsed — never executed. NaN/Infinity values
are converted to JSON null so responses are always valid JSON.
"""

import csv
import io
import math
from pathlib import Path

from .config import (
    MAX_RESULT_ROWS,
    MAX_TABULAR_COLUMNS,
    MAX_TABULAR_ROWS,
    TABULAR_SAMPLE_ROWS,
)
from .detector import decode_text
from .errors import CorruptFileError, DependencyMissingError, InvalidRequestError

OPERATIONS = {"profile", "filter", "sort", "aggregate"}
FILTER_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "contains", "isnull", "notnull"}
NUMERIC_OPS = {"gt", "gte", "lt", "lte"}
AGG_FUNCTIONS = {"sum", "mean", "min", "max", "count", "median"}


def _pandas():
    try:
        import numpy as np
        import pandas as pd
    except ImportError as exc:
        raise DependencyMissingError("pandas is not installed. Run: pip install -r requirements.txt") from exc
    return pd, np


def _detect_delimiter(text, filename):
    if Path(filename or "").suffix.lower() == ".tsv":
        return "\t"
    try:
        return csv.Sniffer().sniff(text[:8192], delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def _check_row_lengths(text, delimiter):
    # pandas silently absorbs/truncates an over-long FIRST data row instead
    # of raising, so field counts are verified here for every row.
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    header = None
    for line_number, row in enumerate(reader, start=1):
        if not row:
            continue
        if header is None:
            header = row
            continue
        if len(row) > len(header):
            raise CorruptFileError(
                f"Malformed CSV/TSV file: row {line_number} has {len(row)} fields "
                f"but the header has {len(header)}."
            )


def _read_frame(pd, text, delimiter):
    _check_row_lengths(text, delimiter)
    try:
        frame = pd.read_csv(
            io.StringIO(text),
            sep=delimiter,
            nrows=MAX_TABULAR_ROWS + 1,
            on_bad_lines="error",
            # Without this, an over-long first data row is silently absorbed
            # as an index instead of raising a malformed-row error.
            index_col=False,
        )
    except pd.errors.EmptyDataError as exc:
        raise CorruptFileError("The CSV/TSV file contains no parseable data.") from exc
    except pd.errors.ParserError as exc:
        message = str(exc).split("\n")[0][:300]
        raise CorruptFileError(f"Malformed CSV/TSV file: {message}") from exc
    except ValueError as exc:
        raise CorruptFileError(f"Could not parse the CSV/TSV file: {str(exc)[:300]}") from exc

    row_limit_reached = len(frame) > MAX_TABULAR_ROWS
    if row_limit_reached:
        frame = frame.iloc[:MAX_TABULAR_ROWS].copy()
    if frame.shape[1] > MAX_TABULAR_COLUMNS:
        raise InvalidRequestError(f"Too many columns ({frame.shape[1]}); the limit is {MAX_TABULAR_COLUMNS}.")
    return frame, row_limit_reached


def _clean_value(value, np, pd):
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        number = float(value)
        return None if math.isnan(number) or math.isinf(number) else number
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def _records(frame, np, pd, limit):
    rows = []
    for values in frame.head(limit).itertuples(index=False, name=None):
        rows.append({str(col): _clean_value(value, np, pd) for col, value in zip(frame.columns, values)})
    return rows


def _rounded(value):
    if value is None:
        return None
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        return None
    return round(number, 6)


def _require_columns(frame, names):
    missing = [name for name in names if name not in frame.columns]
    if missing:
        raise InvalidRequestError(f"Unknown column(s): {', '.join(map(str, missing))}.")


def _column_names(options, key):
    value = options.get(key)
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
        raise InvalidRequestError(f"'{key}' must be a column name or a non-empty list of column names.")
    return value


def _profile(frame, np, pd):
    columns = []
    for name in frame.columns:
        series = frame[name]
        missing = int(series.isna().sum())
        columns.append({
            "name": str(name),
            "dtype": str(series.dtype),
            "missing": missing,
            "missingPct": round(missing / len(frame) * 100, 2) if len(frame) else 0.0,
            "unique": int(series.nunique()),
        })

    numeric_summary = {}
    for name in frame.select_dtypes(include="number").columns:
        stats = frame[name].describe()
        numeric_summary[str(name)] = {
            key: _rounded(stats.get(key))
            for key in ("count", "mean", "std", "min", "25%", "50%", "75%", "max")
        }

    return {
        "columns": columns,
        "numericSummary": numeric_summary,
        "sampleRows": _records(frame, np, pd, TABULAR_SAMPLE_ROWS),
    }


def _filter(frame, options, np, pd):
    column = options.get("column")
    op = options.get("op")
    if not isinstance(column, str):
        raise InvalidRequestError("'column' must be a column name.")
    if op not in FILTER_OPS:
        raise InvalidRequestError(f"Unknown filter op '{op}'. Use one of: {', '.join(sorted(FILTER_OPS))}.")
    _require_columns(frame, [column])
    series = frame[column]

    if op == "isnull":
        mask = series.isna()
    elif op == "notnull":
        mask = series.notna()
    elif op == "contains":
        if "value" not in options:
            raise InvalidRequestError("'value' is required for the contains filter.")
        mask = series.astype(str).str.contains(str(options["value"]), case=False, na=False, regex=False)
    elif op in NUMERIC_OPS:
        if not pd.api.types.is_numeric_dtype(series):
            raise InvalidRequestError(f"Filter '{op}' requires a numeric column ('{column}' is {series.dtype}).")
        try:
            value = float(options["value"])
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidRequestError("'value' must be a number for this filter.") from exc
        mask = {"gt": series > value, "gte": series >= value, "lt": series < value, "lte": series <= value}[op]
    else:
        if "value" not in options:
            raise InvalidRequestError(f"'value' is required for the {op} filter.")
        value = options["value"]
        if pd.api.types.is_numeric_dtype(series):
            try:
                value = float(value)
            except (TypeError, ValueError) as exc:
                raise InvalidRequestError("'value' must be a number for a numeric column.") from exc
        mask = series == value if op == "eq" else series != value

    matched = frame.loc[mask]
    return {
        "totalMatches": int(len(matched)),
        "rows": _records(matched, np, pd, MAX_RESULT_ROWS),
        "truncated": len(matched) > MAX_RESULT_ROWS,
    }


def _sort(frame, options, np, pd):
    by = _column_names(options, "by")
    _require_columns(frame, by)
    ascending = options.get("ascending", True)
    if isinstance(ascending, list) and len(ascending) != len(by):
        raise InvalidRequestError("'ascending' list must match the number of sort columns.")
    if not isinstance(ascending, (bool, list)):
        raise InvalidRequestError("'ascending' must be a boolean or a list of booleans.")
    ordered = frame.sort_values(by=by, ascending=ascending, na_position="last")
    return {
        "rows": _records(ordered, np, pd, MAX_RESULT_ROWS),
        "truncated": len(ordered) > MAX_RESULT_ROWS,
    }


def _aggregate(frame, options, np, pd):
    group_by = _column_names(options, "groupBy")
    aggregations = options.get("aggregations")
    if not isinstance(aggregations, dict) or not aggregations:
        raise InvalidRequestError("'aggregations' must be an object mapping column names to functions.")
    for column, function in aggregations.items():
        if function not in AGG_FUNCTIONS:
            raise InvalidRequestError(f"Unknown aggregation '{function}'. Use one of: {', '.join(sorted(AGG_FUNCTIONS))}.")
    _require_columns(frame, group_by + list(aggregations.keys()))

    try:
        grouped = frame.groupby(group_by, dropna=False).agg(aggregations).reset_index()
    except (TypeError, ValueError) as exc:
        raise InvalidRequestError(f"Aggregation failed: {str(exc)[:200]}") from exc
    return {
        "groups": int(len(grouped)),
        "rows": _records(grouped, np, pd, MAX_RESULT_ROWS),
        "truncated": len(grouped) > MAX_RESULT_ROWS,
    }


def analyze(data: bytes, filename: str, options=None) -> dict:
    """Run one tabular operation and return a JSON-serializable payload."""
    pd, np = _pandas()
    if options is None:
        options = {}
    if not isinstance(options, dict):
        raise InvalidRequestError("'options' must be a JSON object.")
    operation = options.get("operation", "profile")
    if operation not in OPERATIONS:
        raise InvalidRequestError(f"Unknown operation '{operation}'. Use one of: {', '.join(sorted(OPERATIONS))}.")

    text, encoding = decode_text(data)
    delimiter = _detect_delimiter(text, filename)
    frame, row_limit_reached = _read_frame(pd, text, delimiter)

    if operation == "profile":
        payload = _profile(frame, np, pd)
    else:
        handlers = {"filter": _filter, "sort": _sort, "aggregate": _aggregate}
        payload = handlers[operation](frame, options, np, pd)
    return {
        "operation": operation,
        "delimiter": delimiter,
        "encoding": encoding,
        "rowCount": int(len(frame)),
        "columnCount": int(frame.shape[1]),
        "columnNames": [str(name) for name in frame.columns],
        "rowLimitReached": row_limit_reached,
        **payload,
    }