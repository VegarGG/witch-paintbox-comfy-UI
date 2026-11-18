#!/usr/bin/env bash
# Offline only. Task wrappers import the same tests once; do not add their source files again.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-node}"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  "$NODE" "$ROOT/node_modules/typescript/bin/tsc" -p "$ROOT/tsconfig.json"
fi
"$NODE" --experimental-vm-modules --test \
  "$ROOT/tests/image-workflow.test.mjs" \
  "$ROOT/tests/openai-image-26.test.mjs" \
  "$ROOT/tests/illustration-selection.test.mjs" \
  "$ROOT/tests/direct-image-inline.test.mjs" \
  "$ROOT/qa/T-01/workflow.test.mjs" \
  "$ROOT/qa/T-01/protocol.test.mjs" \
  "$ROOT/qa/T-02/settings.test.mjs" \
  "$ROOT/qa/T-02/direct.test.mjs" \
  "$ROOT/qa/T-03/delivery.test.mjs"
