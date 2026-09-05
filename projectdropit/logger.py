"""Thread-safe rotating file and memory-buffered logger for projectdropit.

Ensures all background services (Zeroconf, ReceiverServer, Updater, TCP sessions)
have detailed diagnostic logs without polluting stdout or breaking the Rich TUI.
"""
from __future__ import annotations

import collections
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Deque, List, Optional

from .config import CONFIG_DIR

LOG_FILE = CONFIG_DIR / "dropit.log"
MAX_LOG_BYTES = 5 * 1024 * 1024  # 5 MB
BACKUP_COUNT = 2
RECENT_LOGS_LIMIT = 100

_recent_logs: Deque[str] = collections.deque(maxlen=RECENT_LOGS_LIMIT)
_initialized = False


class _RingBufferHandler(logging.Handler):
    """In-memory ring buffer capturing the last N log lines for the CLI diagnostics screen."""

    def __init__(self, buffer: Deque[str]):
        super().__init__()
        self._buffer = buffer

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            self._buffer.append(msg)
        except Exception:
            self.handleError(record)


def init_logging(level: int = logging.INFO) -> None:
    """Initialize file-based rotating logger and memory buffer.

    Safe to call multiple times (idempotent).
    """
    global _initialized
    if _initialized:
        return

    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    logger = logging.getLogger("projectdropit")
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] [%(name)s:%(threadName)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # In-memory buffer handler for CLI diagnostics
    ring_handler = _RingBufferHandler(_recent_logs)
    ring_handler.setLevel(logging.DEBUG)
    ring_handler.setFormatter(formatter)
    logger.addHandler(ring_handler)

    # Rotating file handler
    try:
        file_handler = RotatingFileHandler(
            LOG_FILE,
            maxBytes=MAX_LOG_BYTES,
            backupCount=BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except Exception:
        # If disk/permissions prevent writing log file, continue with memory handler only
        pass

    _initialized = True
    logger.info("projectdropit logging initialized")


def get_logger(name: str) -> logging.Logger:
    """Get a namespaced logger under projectdropit."""
    if not _initialized:
        init_logging()
    return logging.getLogger(f"projectdropit.{name}")


def get_recent_logs(count: int = 50) -> List[str]:
    """Retrieve the most recent in-memory log entries for display in TUI."""
    entries = list(_recent_logs)
    return entries[-count:] if count < len(entries) else entries
