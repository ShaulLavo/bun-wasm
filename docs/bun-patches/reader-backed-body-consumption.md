# Reader-backed Request and Response bodies

## Classification

`body_streams.ts` and the `streamBytes` call in `web.js`, both under
`crates/bunwasm-runtime/src/js`, are original adapters. No upstream implementation
is copied. This record owns the reader consumption change, not the existing
async-iterable-to-body adapter documented in `async-iterable-body.md`.

Request and Response consume ReadableStream bodies through their default reader.
They do not require the host to implement stream async iteration. A reader iterator
keeps reader ownership local without unwrapping Promise-valued chunks. It serializes
next and return operations so cancellation waits for an outstanding read. Normal completion and read rejection release the
lock without cancellation. Early return and consumer exceptions cancel the
reader before releasing its lock. A read rejection retains its original value,
including undefined or null. The caller's exception still wins if cancellation
also rejects, following the language's async iterator closing rules.

The byte conversion and bodyUsed paths remain unchanged. Generic body producers
still use the existing fromAsyncIterable adapter. Bun's stream conversion and shell collection are not changed. The separate
stream-consumers record owns its concrete web-stream dispatch.

The regression uses real native ReadableStreams with values and
Symbol.asyncIterator shadowed, and the actual body and web factories. It checks
Request and Response data, bodyUsed, locked bodies, read errors, chunk boundaries,
early return, cancellation and consumer errors. The portable page and worker
probe compares baseline and candidate factories with untouched and adapted host
constructors. iOS Safari 26.5 page and worker measurements show missing iterator support and
failing stream consumers in a secure, nonisolated context. The original Nuxt
throwing site is still unmeasured; this is not an SSR acceptance claim.
