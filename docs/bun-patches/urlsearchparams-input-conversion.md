### URLSearchParams input conversion

`crates/bunwasm-runtime/src/js/url_search_params.ts` is an original **Host feature** adapter. No upstream implementation is copied. Its behavior is measured against installed Bun 1.4.4, revision `38afee6c8`, rather than inferred from the older 1.4.2 review oracle. The shared `web.js` URLSearchParams class calls it at input boundaries. Lone UTF-16 surrogates become U+FFFD before storage and form encoding. Symbol values throw TypeError. Record keys collapse after scalar-string conversion, while sequence entries retain repeated keys.

The sequence adapter reads the iterator method once, converts values as the iterator yields them, and lets Array.from preserve iterator closing and user-thrown error identity. Pair length validation follows sequence conversion. Primitive pairs report Bun's ERR_INVALID_ARG_TYPE; malformed object pairs report its TypeError. The focused `runtime-urlsearchparams-edges` fixture covers these cases, coercion order, iterator closing and the legacy format caller without changing its query-selection policy.

The adjacent `node_url.ts` file-URL validator calls the intrinsic URL href getter to reject objects that inherit URL.prototype without URL state. This is an original brand-check adapter. It does not call an input's own getters during validation or replace errors thrown later by a real URL's getters. The upstream paths and Bun pin for the existing port remain listed in [Node URL helpers](node-url-helpers.md).

The receiver-order correction lives in the TypeScript `convertMethodArgs` bridge. It calls the class's private-list accessor before any name or value coercion and does not catch or replace the engine's receiver TypeError. The five existing `web.js` methods supply that accessor because private fields can only be read inside their declaring class. Their remaining list operations stay in place and read the current list after coercion, so a valid receiver's reentrant mutation is not replaced by an earlier list snapshot. This is minimal JavaScript wiring into live TypeScript logic, not a class rewrite or an unused helper. Existing valid conversions remain once-only and user-thrown values leave unchanged.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/url_search_params.ts` | Host feature | Original scalar-string, record, sequence and receiver-first method conversion adapters. |
| `crates/bunwasm-runtime/src/js/web.js`, URLSearchParams wiring | Host feature | Call the TypeScript conversion adapter from the existing class's private-field scope. |
| `crates/bunwasm-runtime/src/js/node_url.ts`, file-URL brand check | Host feature | Validate URL internal state through the intrinsic href getter before reading public fields. |

[Ledger scope and pinned revisions](scope.md).
