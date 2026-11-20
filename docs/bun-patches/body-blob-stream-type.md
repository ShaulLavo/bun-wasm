# The Blob type behind a body stream

Class **Runtime behavior**, **original adapter** in `crates/bunwasm-runtime/src/js/body_streams.ts`
and `web.js`. No upstream code is copied or adapted. The behavioral reference is Bun at
revision `9510e74152073d850a18758ca41114d8f214ffa6` (`test/js/web/fetch/body.test.ts`,
"blob-backed stream bodies"), checked against native Bun 1.4.4.

A stream over bytes in memory (`blob.stream()`, or the `.body` of a Blob-backed Request
or Response) already remembered those bytes, so a body built from it could take them back
without reading. It now also remembers the Blob's type. A Request or Response built from
such a stream keeps the type, so `blob()` returns a Blob of that type, as Bun lifts the
Blob back out of the stream. A slice keeps its own type, and a stream with no Blob behind
it has none.

Bun then adds the type as a Content-Type header to a Request, but not to a Response; the
runtime does the same. Tees and the stream a Request's body moves into keep both the
bytes and the type.

The `body-blob-stream-type` fixture compares this with native Bun.
