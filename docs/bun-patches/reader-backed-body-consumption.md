# Reader-backed Request and Response bodies

## Classification

`body_streams.ts` and the `streamBytes` call in `web.js`, both under
`crates/bunwasm-runtime/src/js`, are original adapters. No upstream implementation
is copied. This record owns the reader consumption change, not the existing
async-iterable-to-body adapter documented in `async-iterable-body.md`.

Request and Response consume ReadableStream bodies through their default reader.
They do not require the host to implement stream async iteration. A direct read loop
keeps reader ownership local without unwrapping Promise-valued chunks. Normal
completion and read rejection release the lock without cancellation. A synchronous
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
