#!/bin/sh
# Clear xdrop's local Python bytecode caches and launch it from this checkout.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_DIR"

# Clear Python bytecode caches so the app starts from the current source.
find xdrop -type d -name __pycache__ -prune -exec rm -rf {} +
find xdrop -type f -name '*.py[co]' -delete

export PYTHONDONTWRITEBYTECODE=1
exec python3 -m xdrop "$@"
