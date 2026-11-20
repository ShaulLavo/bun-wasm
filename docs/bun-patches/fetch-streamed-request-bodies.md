# Streamed fetch request bodies

Class **Host feature**, **original adapters** in the native reqwest binding
(`crates/bunwasm-host/src/net/fetch.rs`, `mod.rs`, `slots.rs`), the guest slot table
(`crates/bunwasm-runtime/src/host.rs`, `natives.rs`), the runtime's fetch
(`crates/bunwasm-runtime/src/js/net.js`, `fetch_lifetime.ts`, `body_streams.ts`), and
the Browser engine's Node test host (`web/scripts/node-net.mjs`,
`web/src/net/trampoline.ts`). No upstream code is copied or adapted. The behavioral
reference is Bun's HTTP client at revision `9510e74152073d850a18758ca41114d8f214ffa6`
(`test/js/web/fetch/client-fetch.test.ts` and `body.test.ts`), checked against native
Bun 1.4.4.

Before this change the runtime read a `ReadableStream` request body to its end and sent
it with a Content-Length. Bun streams it instead, so an upload starts before its source
finishes, and a stream that waits on the server (a duplex exchange) can complete.

- The host ABI gains slot 18, `fetch_stream(meta, meta_len)` (see
  [Host ABI](../host-abi.md#fetch_streammeta_ptr-meta_len---handle)). The guest writes
  body bytes to the handle with `write` and ends the body with `shutdown`. A host that
  leaves the slot at 0 keeps the old whole-body upload; real browsers do, since a page's
  `fetch` cannot stream an HTTP/1.1 upload.
- The runtime streams a body that is a stream with no bytes in memory behind it. A
  string, a Blob, or an untouched stream over either (`new Response("x").body`,
  `blob.stream()`, a Request's body moved into another Request) is still sent whole with
  a Content-Length, as Bun lifts the bytes back out.
- Without a caller Content-Length the body goes out chunked, one chunk per non-empty
  read. An empty read sends nothing, so it can no longer look like the `0\r\n\r\n`
  terminator. With a caller Content-Length the bytes go out raw.
- A body longer or shorter than the caller's Content-Length rejects the fetch with Bun's
  `Error` `ERR_HTTP_CONTENT_LENGTH_MISMATCH` ("Request body of N bytes does not match the
  Content-Length of L", N counting up to the chunk that overflowed). The overflowing chunk
  is never sent; both hosts count what the guest writes.
- The request starts on the next event-loop turn, so an abort in the same turn sends
  nothing, and until then the request's stream stays unlocked and its body unused, as in
  Bun. An abort later cancels the source without a reason, as Bun does. A source that
  fails rejects the fetch with its error; a chunk that is neither a string nor bytes
  rejects it with Bun's `TypeError` `ERR_INVALID_ARG_TYPE` ("write() expects a string,
  ArrayBufferView, or ArrayBuffer").
- `write` reports backpressure while 256 KiB is unsent (Node host: 1 MiB, its connection
  limit).
- Only a 303 redirect is followed with a streamed body, as in Bun (Fetch's
  HTTP-redirect fetch, step 11): any other followed redirect rejects with Bun's
  `TypeError` "Request body is a ReadableStream and cannot be replayed for this
  redirect".

The Node host also resends the method and body on a 301 or 302 that is not a POST, as
the native host already did and Bun does (`redirect with body` in
`client-fetch.test.ts`).

Every method other than GET and HEAD now sends `content-length: 0` for an empty or
absent body, as Bun does; both hosts used to send no framing header at all.

The `fetch-stream-upload` fixture and the `net::tests::fetch_stream_*` launcher tests
compare this with native Bun.
