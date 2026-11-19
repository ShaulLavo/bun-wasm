### URLSearchParams input conversion

`crates/bunwasm-runtime/src/js/url_search_params.ts` is an original **Host feature** adapter. No upstream implementation is copied. Its behavior is measured against installed Bun 1.4.4, revision `38afee6c8`, rather than inferred from the older 1.4.2 review oracle. The shared `web.js` URLSearchParams class calls it at input boundaries. Lone UTF-16 surrogates become U+FFFD before storage and form encoding. Symbol values throw TypeError. Record keys collapse after scalar-string conversion, while sequence entries retain repeated keys.

The sequence adapter reads the iterator method once, converts values as the iterator yields them, and lets Array.from preserve iterator closing and user-thrown error identity. Pair length validation follows sequence conversion. Primitive pairs report Bun's ERR_INVALID_ARG_TYPE; malformed object pairs report its TypeError. The focused `runtime-urlsearchparams-edges` fixture covers these cases, coercion order, iterator closing and the legacy format caller without changing its query-selection policy.

The adjacent `node_url.ts` file-URL validator calls the intrinsic URL href getter to reject objects that inherit URL.prototype without URL state. This is an original brand-check adapter. It does not call an input's own getters during validation or replace errors thrown later by a real URL's getters. The upstream paths and Bun pin for the existing port remain listed in [Node URL helpers](node-url-helpers.md).

The receiver-order correction lives in the TypeScript `convertMethodArgs` bridge. It calls the class's private-list accessor before any name or value coercion and does not catch or replace the engine's receiver TypeError. The five existing `web.js` methods supply that accessor because private fields can only be read inside their declaring class. Their remaining list operations stay in place and read the current list after coercion, so a valid receiver's reentrant mutation is not replaced by an earlier list snapshot. This is minimal JavaScript wiring into live TypeScript logic, not a class rewrite or an unused helper. Existing valid conversions remain once-only and user-thrown values leave unchanged.

`util.inspect` output follows Node 26.12.1's `URLSearchParams.prototype[inspect.custom]` in `lib/internal/url.js`, which Bun 1.4.4's `node:util` matches: `URLSearchParams { 'k' => 'v' }`, one entry per line once the entries exceed the break length, `[Object]` past the depth limit, and the subclass name for subclasses. `inspectParams` in `url_search_params.ts` reimplements that format; no Node code is copied. The class's `nodejs.util.inspect.custom` method in `web.js` calls it with the list from its private field, so a URL's `searchParams` field prints its entries too. Before this, the class had no inspect hook and printed `{}`. One difference remains: native `Bun.inspect` on a URLSearchParams uses Bun's own grouped format (`"a": [ "1", "3" ]`), while here it uses the same Node format through the custom hook. The `url-search-params-inspect` fixture covers the `util.inspect` output.

With `showHidden`, the URL inspect hook in `web.js` also adds Node's `Symbol(context): URLContext { ... }`: ada's component offsets into the href (`protocol_end` through `hash_start`), the port number and the scheme type, with `hasPort`, `hasSearch` and `hasHash` prototype getters. `urlContext` in `url_search_params.ts` ports Bun's `jsDOMURLMakeURLContext` from `src/jsc/bindings/webcore/JSDOMURL.cpp` at Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`, which rebuilds the offsets from the URL's public getters rather than reading the parser's state. That includes the URL Standard's `/.` guard for a null host with an empty first path segment, and reading an empty-but-present search or hash from the href's delimiters. The scheme numbers follow ada's: `http:` 0, `https:` 2, `ws:` 3, `ftp:` 4, `wss:` 5, `file:` 6 and 1 for every other scheme. The `url-context-inspect` fixture compares fifteen URLs with native Bun 1.4.4.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/url_search_params.ts` | Host feature | Original scalar-string, record, sequence and receiver-first method conversion adapters. |
| `crates/bunwasm-runtime/src/js/web.js`, URLSearchParams wiring | Host feature | Call the TypeScript conversion adapter from the existing class's private-field scope. |
| `crates/bunwasm-runtime/src/js/node_url.ts`, file-URL brand check | Host feature | Validate URL internal state through the intrinsic href getter before reading public fields. |
| `crates/bunwasm-runtime/src/js/url_search_params.ts`, `inspectParams` | Adapted implementation | Node 26.12.1 `lib/internal/url.js` `URLSearchParams[inspect.custom]` format, reimplemented. |
| `crates/bunwasm-runtime/src/js/web.js`, URLSearchParams inspect hook | Host feature | Call `inspectParams` with the private pair list. |
| `crates/bunwasm-runtime/src/js/url_search_params.ts`, `urlContext` | Adapted implementation | Bun `src/jsc/bindings/webcore/JSDOMURL.cpp` `jsDOMURLMakeURLContext` at `9510e74152073d850a18758ca41114d8f214ffa6`, ported to TypeScript. |
| `crates/bunwasm-runtime/src/js/web.js`, URL inspect hook | Host feature | Add the `Symbol(context)` field when `showHidden` is set. |

[Ledger scope and pinned revisions](scope.md).
