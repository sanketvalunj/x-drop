#!/bin/sh
# Create an isolated environment, install this checkout, and launch the dashboard.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

find xdrop -type d -name __pycache__ -prune -exec rm -rf {} +
find xdrop -type f -name '*.py[co]' -delete

export PYTHONDONTWRITEBYTECODE=1
PYTHON="$PROJECT_DIR/.venv/bin/python"
if [ -x "$PYTHON" ]; then
  PYTHON_VERSION=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
else
  PYTHON_VERSION=
fi

# Prefer Python 3.12 when rebuilding an environment. It has broad wheel support
# for the native cryptography dependency across supported platforms.
if [ "$PYTHON_VERSION" != "3.12" ]; then
  if command -v python3.12 >/dev/null 2>&1; then
    rm -rf "$PROJECT_DIR/.venv"
    python3.12 -m venv "$PROJECT_DIR/.venv"
  elif [ ! -x "$PYTHON" ]; then
    python3 -m venv "$PROJECT_DIR/.venv"
  fi
fi
PYTHON="$PROJECT_DIR/.venv/bin/python"
"$PYTHON" -m pip install --disable-pip-version-check -e "$PROJECT_DIR"
exec "$PYTHON" -m xdrop.web "$@"
