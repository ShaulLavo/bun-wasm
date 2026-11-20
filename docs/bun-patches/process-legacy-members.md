# Process legacy members and `process.binding`

Class **Port**, with one **Adapted upstream implementation**. Node's private and legacy
`process` members follow Bun at revision `9510e74152073d850a18758ca41114d8f214ffa6`.

| Upstream | Class | Behaviour reproduced | Where |
| --- | --- | --- | --- |
| `src/jsc/bindings/BunProcess.cpp` `processObjectTable`, `Process::finishCreation` | Port | `_tickCallback` and `_linkedBinding` return `undefined`; `_getActiveRequests` and `_getActiveHandles` return an empty array; `moduleLoadList` and `_preload_modules` are empty arrays. `_debugEnd`, `_debugProcess`, `_startProfilerIdleNotifier` and `_stopProfilerIdleNotifier` return `undefined` on the main thread only: a worker's process has none, as in Node and Bun | `crates/bunwasm-runtime/src/js/process.ts`; `worker_threads.ts` `initializeData` removes the main-thread stubs |
| `BunProcess.cpp` `constructProcessConfigObject` (Linux branch) | Port | `process.config` is frozen and holds Bun's `variables`, including `node_without_node_options: true` and `clang: 0`. `host_arch` and `target_arch` report the guest's `process.arch` (`wasm32`) instead of the host CPU | `process.ts` `processConfig` |
| `src/js/builtins/ProcessObjectInternals.ts` `buildAllowedNodeEnvironmentFlags` (SHA-256 of the file `1c3ac5faffcd22b82185a237105f75c70f781635123dd4455b92ae944b1c7115`) | Adapted upstream implementation | `process.allowedNodeEnvironmentFlags` is a frozen `Set` subclass with Bun's flag list whose `has()` normalizes `_` to `-`, missing dashes and `=value` suffixes and whose `add`, `delete` and `clear` do nothing. Changes: TypeScript types, `.call` for Bun's `$call`, and a lazy getter on `process` instead of a lazy property callback | `crates/bunwasm-runtime/src/js/process_allowed_flags.ts` |
| `BunProcess.cpp` `Process_functionBinding`, `processBindingConfig`, `createCryptoX509Object`; `ProcessBindingBuffer.cpp`, `ProcessBindingFs.cpp`, `ProcessBindingHTTPParser.cpp` (with `node/http/llhttp/llhttp.h` method maps), `ProcessBindingNatives.cpp`, `ProcessBindingTTYWrap.cpp` | Port | `process.binding(name)` answers Bun's list. `buffer`, `config`, `crypto/x509`, `fs`, `http_parser`, `natives`, `tty_wrap` and `util` return an object cached per name; their functions that Bun never implemented throw Bun's "is not implemented in Bun" error. The Node internals Bun lacks throw that error for the binding itself, `stream_wrap` with Bun's issue link, and other names throw `No such module`. A symbol name throws a `TypeError`. `constants` and `uv` keep their existing objects | `crates/bunwasm-runtime/src/js/process_binding.ts`; `process.ts` `binding` |

## Differences from native Bun 1.4.4

- `http_parser.HTTPParser` and `ConnectionsList` are absent: bun-wasm has no native HTTP parser
  class to expose. `tty_wrap.TTY` throws when constructed. `config.bits` is 32.
- Bun warns once with DEP0111 when `--pending-deprecation` is set and user code calls
  `process.binding()`; bun-wasm has no such option.

## Tests

The native fixture `process-legacy-members` holds native Bun's output and runs on all three
engines. Upstream `test/js/node/process/process.test.js` covers the same members.

[Ledger scope and pinned revisions](scope.md).
