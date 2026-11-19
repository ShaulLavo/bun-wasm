## Bun thirdparty fetch builtins

Bun replaces four npm packages with its own modules, even when a project installs them: `node-fetch`, `undici`, `isomorphic-fetch` and `@vercel/fetch` (`src/resolve_builtins/HardcodedModule.rs`, `BUN_EXTRA_ALIAS_KVS`, at Bun `9510e74152073d850a18758ca41114d8f214ffa6`). bun-wasm now does the same. The Rust resolver lists the four names as builtins, ahead of `node_modules`, and the builtin registry loads Bun's generated `src/js/thirdparty/node-fetch.ts`, `undici.js`, `isomorphic-fetch.ts` and `vercel_fetch.js` through the existing [builtin loader](builtin-loader-adapter.md). The generated factories are unchanged [generated builtins](bun-generated-builtins.md).

Two `$cpp` binding objects, `createNodeFetchInternalBinding` (`src/jsc/bindings/NodeFetch.cpp`) and `createUndiciInternalBinding` (`src/jsc/bindings/Undici.cpp`), only return the runtime's web classes in a fixed order. `src/js/bun_builtins.ts` builds the same arrays from the global constructors when the module first loads.

The modules also require two Bun internal modules. Embedding Bun's copies would pull in Bun's whole internal streams stack, a second `Readable` class that user code's `node:stream` would not recognize. `scripts/bun-builtins.json` lists them under `runtimeProvided`; the generator neither embeds them nor follows their dependencies, and `src/js/bun_provided_internals.ts` implements them over bun-wasm's own classes:

- `internal:webstreams_adapters` exports `_ReadableFromWeb`, adapted from Bun's `ReadableFromWeb` in `src/js/internal/webstreams_adapters.ts`. The algorithm is Bun's: one `reader.read()` per `_read()`, cancellation on destroy, and the `responseBody` option that treats a body already locked by `text()` or `json()` as ended. It extends bun-wasm's `node:stream` `Readable` and uses ordinary methods in place of Bun's `$`-intrinsics. The code was split into smaller private methods.
- `internal:tls` exports `nodeClientTlsToNative`, adapted from `src/js/internal/tls.ts`. It copies the same list of TLS option names from an `https.Agent`'s options into fetch's `tls` option and coerces `rejectUnauthorized`. Bun's PEM key normalization, cipher-list rewriting, protocol-version conversion and secure-context validation are not ported, because fetch over the bun-wasm hosts does not apply client TLS options.

Limits: `blobFrom` and `fileFrom` in node-fetch call `Promise.$resolve`, a JSC private method the loader does not provide, so they throw. undici's `request()` passes Bun's `maxRedirects` fetch option for `maxRedirections`; `fetch_args.ts` validates it, but nothing applies it, so the host follows redirects without that limit. The Next.js aliases (`next/dist/compiled/node-fetch`, `next/dist/compiled/undici`, `next/dist/compiled/ws`), `ws/lib/websocket`, `abort-controller` and `utf-8-validate` still load from `node_modules`.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/generated/builtins/192.js` to `195.js`](#bun-thirdparty-fetch-builtins) | Port | Bun's generated thirdparty fetch modules, unchanged. |
| [`src/js/bun_provided_internals.ts`](#bun-thirdparty-fetch-builtins) | Port | `_ReadableFromWeb` and `nodeClientTlsToNative`, adapted from Bun over bun-wasm's `node:stream`. |
| [Resolver names, registry entries, binding hooks and `runtimeProvided` entries](#bun-thirdparty-fetch-builtins) | Host feature | Original glue that resolves the four package names to Bun's modules on every engine. |

[Ledger scope and pinned revisions](scope.md).
