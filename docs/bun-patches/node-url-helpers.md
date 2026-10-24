### Node URL helpers

`crates/bunwasm-runtime/src/js/node_url.ts`. Class **Port**. Upstream `src/js/internal/url.ts` (`urlToHttpOptions`) and `src/js/node/url.ts` (legacy Url fields and format fragments) at the Bun pin. Related code also exists in `src/node-fallbacks/url.js`.

Retain HTTP option extraction, IPv6 hostname handling, auth decoding, legacy field initialization, and format escaping. Replace native URL machinery and internal validators with the local WHATWG URL implementation and error helpers. File-URL conversion and the simplified legacy parse/resolve wrapper are local code. This adapts the copied helpers without importing Bun's native URL binding. The file was renamed from JavaScript with strict types. Legacy `Url` fields are type-only `declare` fields, so construction still assigns them in the same order. The `domainToASCII` native and `node:querystring` contracts live in `src/js/runtime.d.ts`.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/node_url.ts`](#node-url-helpers) | Port | Adapt Node URL helpers around the local URL implementation. |

[Parent context](bun-patch-series.md).
