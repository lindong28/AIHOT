#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ $# -eq 0 ]]; then set -- status; fi
exec python3 "$here/online-release.py" "$@"
