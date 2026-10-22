#!/bin/sh
# Clear xdrop's local Python bytecode caches and launch the browser dashboard.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

find xdrop -type d -name __pycache__ -prune -exec rm -rf {} +
find xdrop -type f -name '*.py[co]' -delete

export PYTHONDONTWRITEBYTECODE=1
PYTHON="$PROJECT_DIR/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
  PYTHON=python3
fi
exec "$PYTHON" -m xdrop.web "$@"
