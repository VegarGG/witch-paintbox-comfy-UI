#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="${NODE:-node}"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  "$NODE" "$ROOT/node_modules/typescript/bin/tsc" -p "$ROOT/tsconfig.json"
fi
"$NODE" --experimental-vm-modules --test "$ROOT/qa/T-02/settings.test.mjs" "$ROOT/qa/T-02/direct.test.mjs"
