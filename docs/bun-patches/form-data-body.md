# FormData bodies

Class: Adapted implementation.

`crates/bunwasm-runtime/src/js/form_data_body.ts` ports Bun's FormData body
handling at revision `9510e74152073d850a18758ca41114d8f214ffa6`, checked against
native Bun 1.4.4:

- `encoding` follows `form_data::Encoding::get` and `get_boundary` in
  `src/bun_core/util.rs`: a Content-Type containing
  `application/x-www-form-urlencoded` (any case) is urlencoded; one containing
  `multipart/form-data` needs a `boundary` parameter after an unquoted `;`.
- `parse` follows `for_each_multipart_entry` and `to_js_from_multipart_data` in
  `src/runtime/webcore/FormData.rs`, including its quirks: the last
  `--boundary--` ends the body, the 76-byte boundary limit, `name`/`filename`
  values kept with their `\"` escapes, RFC 5987 `filename*` ignored (the part is
  a string entry), nameless parts skipped, a BOM stripped from string values,
  and Bun's error names. Header reading stops once a part has both a `name`
  and a `filename`, so a Content-Type line after that Content-Disposition is
  never read, as in Bun. A file part takes its Content-Type, else the type for
  its extension, else Bun's `MimeType::sniff` image signatures. The extension
  table is the runtime's existing `MIME` table in `web.js` (this change adds
  `bin`), smaller than Bun's, so a rarer extension gets an empty type.
  Urlencoded bodies go through `URLSearchParams` after dropping a UTF-8 BOM.
- `serialize` follows `Blob::from_dom_form_data` and
  `encode_form_data_component` in `src/runtime/webcore/Blob.rs`: a
  `----WebKitFormBoundary` boundary with 32 random hex digits, CRLF newlines in
  names and string values, `"`, CR and LF percent-encoded in names and
  filenames, and `application/octet-stream` for a file without a type.

Local changes: the parser works on byte views in TypeScript instead of Bun's
`DOMFormData`, and file parts become this runtime's `File` objects (Bun returns
Blobs with a name). `web.js` wires it into `Request`/`Response` `formData()`
(`TypeError` with code `ERR_FORMDATA_PARSE_ERROR`, and an undecodable type
rejects without using the body, as in Bun's `Body.rs`), `Blob.formData()`
(Bun's `Invalid encoding` and `FormData encoding failed:` errors) and FormData
request and response bodies. The `form-data-body` fixture compares these with
native Bun.
