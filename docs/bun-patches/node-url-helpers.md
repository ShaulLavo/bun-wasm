### Node URL helpers

`crates/bunwasm-runtime/src/js/node_url.ts`. Class **Port**. Upstream `src/js/internal/url.ts` (`urlToHttpOptions`) and `src/js/node/url.ts` (legacy Url fields and format fragments) at the Bun pin. Related code also exists in `src/node-fallbacks/url.js`.

Retain HTTP option extraction, IPv6 hostname handling, auth decoding, legacy field initialization, and format escaping. Replace native URL machinery and internal validators with the local WHATWG URL implementation and error helpers. File-URL conversion and the simplified legacy parse/resolve wrapper are local code. This adapts the copied helpers without importing Bun's native URL binding. The file was renamed from JavaScript with strict types. Legacy `Url` fields are type-only `declare` fields, so construction still assigns them in the same order. The native and query-string contracts live in `src/js/runtime.d.ts`.

The format query path retains the pinned Bun `src/js/node/url.ts` object-key gate and uses the existing runtime URLSearchParams constructor. Arrays become comma-separated record values, iterable query pairs retain repeated keys, and form encoding matches Bun. Format reads the `query` property once and converts its record or pairs, including value getters, coercion and thrown errors, before it reads `search`, as Bun 1.4.4 does even when `search` is set; this ordering is local to the Port. The file-URL argument validator and invalid-string scheme error are original adapters measured against installed Bun 1.4.2 and 1.4.4.

The adjacent `domainToUnicode` native in `crates/bunwasm-runtime/src/natives.rs` is an original **Host feature** adapter, not a copied punycode implementation. It uses the existing `url` 2.5.8 dependency, `src/quirks.rs` `set_hostname` and `domain_to_unicode`, and its resolved `idna` 1.1.0 dependency. Hostname parsing rejects credentials, ports, invalid IDNA and spaces before decoding. Parsed IPv4 and IPv6 addresses retain their normalized forms. No upstream source is copied or changed. Precise native and URLSearchParams constructor declarations live in `src/js/runtime.d.ts`; the `runtime-ts-url-decoder` fixture covers public coercion, errors, query values, encoding, IDNA, and IP hosts.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/node_url.ts` | Port | Adapt Node URL helpers around the local URL implementation. |
| `crates/bunwasm-runtime/src/natives.rs`, `domainToUnicode` | Host feature | Original adapter to the existing Rust URL/IDNA APIs, with no copied implementation. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
