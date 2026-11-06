# Host result decoding

## Classification and source

| Source | Class | Local change |
| --- | --- | --- |
| `web/src/engine-host.js`, `Reader` and `wasmCaller` | Host feature | Bound native result decoding to the exported result length. |
| `scripts/engine-host-result-bounds.test.ts` | Test fixture | Exercise the production decoder and bridge with controlled exports and real WebAssembly memory. |
| `scripts/engine-host-wire.test.ts` | Test fixture | Supply the logical end when testing the production reader. |
| `web/tests/crypto-lifetime-probe.mjs` | Test fixture | Publish the encoded result length alongside its pointer. |

These are original bun-wasm adapters and fixtures, not copied or adapted upstream
source. There is no upstream path or revision. The corrected host source is based
on bun-wasm `dff55f4505873d7452634d1c159ce0007cdf6e77`.

## Result boundary

`crates/bunwasm-runtime/src/engine_host.rs` already exports the result pointer and
length for both native calls and `bunwasm_describe`. The host reads both exports
and checks their region against fresh memory views after each call. The reader
keeps an exclusive logical end. It checks each tag, scalar, length header, and
raw payload before reading or copying. Array counts need at least one remaining
byte per element. Object counts need at least five per field for the key-length
header and value tag. These checks happen before collection allocation or iteration.

Unknown tags, incomplete values, out-of-bounds regions, and trailing bytes after
one top-level value throw `RangeError("corrupt native result")`. Tag zero still
means `undefined`. Valid native error packets decode before status handling and
keep their error class, message, name, and properties.

Byte values, strings, and object keys retain their independent copies. Result
storage belongs to the guest and can change on the next call. Memory growth can
also invalidate old views. The host still refreshes views after allocation and
native execution.

## Regression scope

`checks/quality-engine-host-result-bounds.json` registers the TypeScript regression
with the blocking quality gate. It evaluates the production Reader, Writer,
wasmCaller, and native-error reconstruction with the installed Waffle memory-view
helper. Only guest exports are controlled stand-ins. Both shared and unshared
WebAssembly memories cover malformed packets, valid values, result reuse, native
errors, and growth during allocation and execution. The largest valid byte
payload is 262,144 bytes. No guest build, browser, device, or memory-pressure run
is part of these controls.

[Ledger scope and pinned revisions](scope.md).
