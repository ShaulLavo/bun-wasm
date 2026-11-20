# Blob types, construction and slicing

Class **Runtime behavior** with one **copied file**.

- **Copied:** `crates/bunwasm-runtime/data/bun-mime-types.txt` is Bun's
  `src/http_types/mime_type_list.txt` at revision `9510e74152073d850a18758ca41114d8f214ffa6`,
  unchanged (2,300 types, 63 KB). `crates/bunwasm-runtime/src/mime_types.rs` looks a type up
  in it with an exact, case-sensitive match and gives the canonical values of `MimeType.rs`
  `by_name_static` (`text/plain` is `text/plain;charset=utf-8`, and so on). The runtime does
  not link Bun's `bun_http_types` crate because it pulls in `bun_url`, whose WebKit symbols
  host-side builds of the runtime do not have.
- **Original adapters:** the Blob and File classes in `crates/bunwasm-runtime/src/js/web.js`
  and `BunFile.slice` in `bun.js`, following Bun's `src/runtime/webcore/Blob.rs`
  (`constructor`, `get_slice`, `get_slice_from`, `is_valid_blob_type`, `get_name`,
  `set_name`) at the same revision, checked against native Bun 1.4.4.

Behavior, as in Bun:

- `new Blob(parts)` takes an Array of parts, or a single ArrayBuffer or view as the only
  part; anything else (a string, a number, a Set) throws `TypeError` `ERR_INVALID_ARG_TYPE`
  "new Blob() expects an Array". Before, any iterable was split into parts, so
  `new Blob(new Uint8Array(…))` stored the numbers as text.
- A type must be printable ASCII, or it becomes `""`. A type in Bun's interned list keeps
  Bun's value for it; any other is lowercased.
- `slice()` reads only numbers as bounds (`NaN` is 0, a negative bound counts back from the
  end, `Infinity` clamps), and a string argument in the first or second place is the type.
  Without a valid type of its own, a slice keeps its parent's type only when that type is
  interned. `Bun.file().slice()` uses the same bounds over the file's size now (Bun's largest
  Blob size when the file cannot be stat'ed).
- `text()` and `json()` decode bytes that start with a UTF-16LE byte order mark as UTF-16LE,
  dropping an odd last byte; anything else is UTF-8 without its byte order mark.
- `name` is an accessor on `Blob.prototype`: a string sets it, `undefined` or `null` clears
  it, and any other value is ignored. `File.prototype` keeps its own accessor, which also
  brands a File for `object_urls.ts`. A Bun.file()'s name is a name set on it, else its path.
- `File`'s `lastModified` goes through ToNumber, and `NaN` becomes 0.
- A Blob or File made from a single Bun.file() reads the file when its bytes are needed, as
  Bun shares the file's store, so `new File([Bun.file(missing)], "a.txt")` does not throw.

The `blob-construction-and-slicing` fixture compares this with native Bun.
