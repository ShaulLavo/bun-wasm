#!/usr/bin/env bash
# The fixture suite on the JavaScriptCore build (dist/bun-jsc.wasm). Kept for muscle memory:
# it is scripts/test.sh --engine jsc (the same fixtures run on both engines).
exec "$(dirname "${BASH_SOURCE[0]}")/test.sh" --engine jsc "$@"
