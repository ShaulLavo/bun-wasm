# Body Content-Type defaults and Headers.toJSON order

## Classification

Class: Adapted behavior in original adapters, with copied header names. The body rules
in `crates/bunwasm-runtime/src/js/web.js` and `http_response.ts` follow Bun's
`src/runtime/webcore/Body.rs` (`get_blob_with_this_value`) and
`src/runtime/server/RequestContext.rs` (`get_content_type`) at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4. The
`commonHeaderNames` list in `web.js` copies the names of WebCore's
`src/jsc/bindings/webcore/HTTPHeaderNames.in` at that revision, lowercased, without
Set-Cookie, which FetchHeaders stores separately.

## Behavior

A string, number or byte body adds no Content-Type when a Request or Response is built;
URLSearchParams, a typed Blob and FormData still add theirs. `blob()` takes the body's
own type first (typed Blob, FormData, URLSearchParams), then the Content-Type header,
and otherwise types a non-empty buffered body `text/plain;charset=utf-8`, as Bun does.
fetch() therefore sends no Content-Type for a string body. Bun.serve still writes one
when the response sets none: `text/plain;charset=utf-8` for a non-empty string body and
`application/octet-stream` for non-empty bytes; a cloned response keeps that choice.
Bun also sniffs untyped Blob bodies; this runtime sends no type for them, as before.

`Headers.toJSON()` lists the well-known names first, then Set-Cookie as an array, then
the other names, each group in insertion order, because FetchHeaders keeps common and
uncommon headers in separate insertion-ordered vectors. Iteration stays sorted.

The `body-content-type` fixture compares constructors, `blob()`, Bun.serve, fetch and
`toJSON()` with native Bun on QuickJS, JSC and Browser.

[Ledger scope and pinned revisions](scope.md).
