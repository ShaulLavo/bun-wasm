## Bun fast-utf8-stream builtin (`fs.Utf8Stream`)

Class **Port** (generated builtin) + **Host feature** (loader glue and validators).

Upstream Bun source revision `a7733435cf40429e3b35c36072769df2052b80f1`, file `src/js/internal/streams/fast-utf8-stream.ts` (ported by Bun from Node.js `lib/internal/streams/fast-utf8-stream.js`, derived from SonicBoom). bun-wasm includes `internal:streams/fast-utf8-stream` in `scripts/bun-builtins.json` and exposes it lazily as `fs.Utf8Stream` from `crates/bunwasm-runtime/src/js/node_fs.js`. The generated module (`crates/bunwasm-runtime/generated/builtins/89.js`) is produced unchanged by `scripts/generate-bun-builtins.sh` (see [bun-generated-builtins.md](bun-generated-builtins.md)).

`fast-utf8-stream.ts` requires `internal/validators` and invokes four `$ERR_*` builtin error constructors (`ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE_RangeError`, `ERR_INVALID_STATE`, `ERR_OPERATION_FAILED`). Because Bun's `src/js/internal/validators.ts` binds C++ functions from `NodeValidator.cpp`, `scripts/bun-builtins.json` lists `internal:validators` under `runtimeProvided` so the generator does not embed Bun's copy:

- `crates/bunwasm-runtime/src/js/bun_provided_internals.ts` provides `internal:validators` (`validateBoolean`, `validateFunction`, `validateObject`, `validateOneOf`, `validateString`, `validateUint32`, and the `kValidateObject*` flags), adapted from `src/js/internal/validators.ts` and Node's validator rules using bun-wasm's `internal.describe` error formatter, together with `makeBuiltinError` for the four error codes above (including `ErrorCode.ts` alternate constructor variants such as `ERR_INVALID_ARG_VALUE_RangeError`).
- `crates/bunwasm-runtime/src/js/bun_builtins.ts` maps `internal:validators` in `runtimeProvided` and delegates `makeErrorWithCode` for those error codes to `bun_provided_internals.makeBuiltinError` (keeping `ERR_INVALID_URI` inline for standalone loader tests).

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/generated/builtins/89.js`](#bun-fast-utf8-stream-builtin-fsutf8stream) | Port | Bun's generated `internal:streams/fast-utf8-stream` module, unchanged. |
| [`crates/bunwasm-runtime/src/js/bun_provided_internals.ts`](#bun-fast-utf8-stream-builtin-fsutf8stream) | Port | `internal:validators` subset and `makeBuiltinError` for `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ERR_INVALID_STATE`, `ERR_OPERATION_FAILED`. |
| [`scripts/bun-builtins.json`, `crates/bunwasm-runtime/src/js/bun_builtins.ts`, `crates/bunwasm-runtime/src/js/node_fs.js`](#bun-fast-utf8-stream-builtin-fsutf8stream) | Host feature | Manifest selection, loader dispatch, and lazy `fs.Utf8Stream` getter. |

[Ledger scope and pinned revisions](scope.md).
