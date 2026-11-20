# Reader-backed Request and Response bodies

## Classification

`body_streams.ts` and the `streamBytes` call in `web.js`, both under
`crates/bunwasm-runtime/src/js`, are original adapters. No upstream implementation
is copied. This record owns the reader consumption change, not the existing
async-iterable-to-body adapter documented in `async-iterable-body.md`.

Request and Response consume ReadableStream bodies through their default reader.
They do not require the host to implement stream async iteration. A direct read loop
keeps reader ownership local without unwrapping Promise-valued chunks. As in Fetch's
"fully read", Bun 1.4.4 and undici, the body's reader is never released (`drain`):
after a mixin method reads the body, its stream stays locked, disturbed and closed,
or errored, and a read rejection leaves no cancellation. A body read before its
`.body` getter ran then returns an already consumed stream (`consumedStream`), so
the stream's state does not depend on what backed the body. A ReadableStream that is
locked or disturbed cannot become a body: construction throws `TypeError: Body
object should not be disturbed or locked`, Bun's message (`adoptable`), and a body
whose stream someone else locked rejects a read with `ERR_INVALID_STATE`
(`Invalid state: ReadableStream is locked`) without becoming used. A keepalive
Request with a stream body throws `TypeError: keepalive` first, as Fetch requires
and Bun checks before the lock.

The polyfill streams keep a `_disturbed` flag, but a host's native streams on the
Browser engine do not expose theirs. On the host engine `body_streams.ts` therefore
wraps the host's `getReader`, the readers' `read` and `cancel`, and the stream's
`cancel`, `pipeTo`, `pipeThrough`, `values` and async iterator once per realm to set
the same flag, so `bodyUsed`, the adoption check and `node:stream`'s `isDisturbed`
see a stream that another party read. The wrappers keep each method's name and
property attributes and only add the flag.
`Bun.write()` reads a Request as well as a Response through the same path.
`node:stream/consumers` keeps `consume`, which releases the lock when done. A synchronous
chunk visitor handles each value. Visitor failure awaits cancellation before
releasing the lock and rejecting with the original error, even when cancellation
rejects. Concrete web-stream consumers do not depend on language-level async
iterator closing; generic iterables retain their original for-await path. A read rejection retains its original value,
including undefined or null. The caller cannot observe the final rejection before cancellation settles and
the lock is released.

The byte conversion and bodyUsed paths remain unchanged. Generic body producers
still use the existing fromAsyncIterable adapter. Bun's stream conversion and shell collection are not changed. The separate
stream-consumers record owns its concrete web-stream dispatch.

The regression uses real native ReadableStreams with values and
Symbol.asyncIterator shadowed, and the actual body and web factories. It checks
Request and Response data, bodyUsed, locked bodies, read errors, chunk boundaries,
generic iterator cleanup, cancellation settlement and consumer errors. The portable page and worker
probe compares baseline and candidate factories with untouched and adapted host
constructors. iOS Safari 26.5 page and worker measurements show missing iterator support and
failing stream consumers in a secure, nonisolated context. The original Nuxt
throwing site is still unmeasured; this is not an SSR acceptance claim.

## Null bodies, native consumers and clone()

A null body is not a zero-length body. A Request or Response made without a body,
`Response.redirect()`, `Response.error()` and a `fetch()` Response to HEAD or with a
null body status (204, 205, 304) return an empty result from every mixin method and
never become used, so `bodyUsed` stays false and `clone()` keeps working. A
zero-length body (`""`, `new Uint8Array(0)`) is still a body and is used up by a read.

The consumers outside the mixin keep their reader the same way: `fetch()` uploading a
Request body (`fetch_lifetime.ts` `requestBody`) and `Bun.serve()` sending a stream
Response (`http_response.ts`) no longer release it, even after an abort or a
disconnect, so the body's stream stays locked, disturbed and closed, as native Bun
1.4.4 leaves it.

`Bun.serve()` gives a handler `req.body === null` for a request that carries no bytes:
no body, `Content-Length: 0` (which is what `fetch()` sends for `""` and an empty
`Uint8Array`), whatever the method. As a null body it is never used up, so `req.text()`
can be called again. A chunked request with no chunks still has a stream body, as in
Bun (`net.js` `runRequest`). Answering HEAD with a string or byte Response consumes
the in-memory body like a GET does: a stream its `.body` made ends locked and
disturbed, `bodyUsed` turns true, and its size becomes the Content-Length when no
header sets one (`http_response.ts` `writeResponse`). A ReadableStream body is still
only cancelled for HEAD, as in Bun. The `serve-empty-request-body` fixture carries
native Bun 1.4.4's output.

`clone()` of a used or locked body throws Bun's `TypeError: Body is disturbed or
locked` with code `ERR_BODY_ALREADY_USED`. An unread stream over bytes already in
memory (a string, Blob or typed array body's `.body`, or `Blob.stream()`) is not
teed: both bodies take the bytes, and the old stream is read to its end and stays
locked, as Bun lifts the payload out of its native stream. `new Request(request)`
over a locked stream reports the tee's `TypeError: Invalid state: ReadableStream is
locked` (`ERR_INVALID_STATE`). `Response.clone()` keeps the source's status, type,
URL and redirect flag, so `Response.error().clone()` is an error Response with status
0 instead of a RangeError. A Request or Response clone also keeps the type of the
Blob behind its body (`_bodyType` from `body-content-type-and-header-order.md`), so
`blob()` on the clone answers what it answers on the source. The `null-body-reads` and `body-native-consumers`
fixtures carry native Bun 1.4.4's output for these cases; the reference is the same
`body.test.ts` and `body-clone.test.ts` revision.

The `body-stream-bookkeeping` fixture compares the stream state after each mixin
method for string, Blob, typed array, URLSearchParams, stream and empty bodies on
Request and Response, plus erroring, externally locked and adopted streams and
`Bun.write()`, with native Bun 1.4.4. The reference is Bun's
`test/js/web/fetch/body.test.ts` "body stream bookkeeping" block at revision
`9510e74152073d850a18758ca41114d8f214ffa6`.
