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

The `body-stream-bookkeeping` fixture compares the stream state after each mixin
method for string, Blob, typed array, URLSearchParams, stream and empty bodies on
Request and Response, plus erroring, externally locked and adopted streams and
`Bun.write()`, with native Bun 1.4.4. The reference is Bun's
`test/js/web/fetch/body.test.ts` "body stream bookkeeping" block at revision
`9510e74152073d850a18758ca41114d8f214ffa6`.
