# Blob type normalization

Class: Adapted implementation.

`normalizeBlobType` in `crates/bunwasm-runtime/src/js/web.js` follows Bun's
`MimeType::by_name_static` in `src/http_types/MimeType.rs` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4. An
exact, case-sensitive match of `text/plain`, `text/html`, `text/css`,
`text/javascript`, `text/jsx`, `application/javascript`, `application/json`,
`application/x-www-form-urlencoded` or `application/webassembly` becomes Bun's
canonical value (for example `text/plain;charset=utf-8` and `application/wasm`).
Any other type is only lowercased, so `text/x-custom` and `TEXT/PLAIN` gain no
charset. Before this, every `text/*` type without a charset gained
`;charset=utf-8`. The table is the subset of Bun's interned list whose canonical
value differs from its key; the rest of that list maps to itself.

Request and Response `blob()` keep the Content-Type header as written and apply only
the exact-match table, as Bun does, so `TEXT/PLAIN` stays uppercase there. Which type
`blob()` starts from is in `body-content-type-and-header-order.md`.
`Blob.slice()` and `File` go through the constructor's rule. The
`blob-type-canonical` fixture compares Blob, File, slice and body `blob()` types
with native Bun.
