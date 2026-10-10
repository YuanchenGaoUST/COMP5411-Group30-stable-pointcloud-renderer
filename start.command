#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
task_python="${PYTHON_BIN:-python3}"
if ! command -v -- "$task_python" >/dev/null 2>&1; then
  printf '%s\n' "Python 3 is required. Install Python 3 and add python3 to PATH, or set PYTHON_BIN to its executable." >&2
  exit 1
fi
exec "$task_python" scripts/serve.py --port "${PORT:-5411}"
