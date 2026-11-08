"""Structured logging that writes ONLY to stderr.

stdout is reserved for the single JSON response consumed by the Node
backend, so log records must never reach it. Messages contain request
metadata (action, file name, sizes, timings) but never file contents,
base64 payloads or secrets.
"""

import json
import logging
import sys


class JsonLineFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure(level=logging.INFO):
    logger = logging.getLogger("maya_engine")
    if logger.handlers:
        return logger
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonLineFormatter())
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False
    return logger