# Reader-backed Request and Response bodies

## Classification

`body_streams.ts` and the `streamBytes` call in `web.js`, both under
`crates/bunwasm-runtime/src/js`, are original adapters. No upstream implementation
is copied. This record owns the reader consumption change, not the existing
async-iterable-to-body adapter documented in `async-iterable-body.md`.

Request and Response consume ReadableStream bodies through their default reader.
They do not require the host to implement stream async iteration. A generator
keeps reader ownership local. Normal completion and read rejection release the
lock without cancellation. Early return and consumer exceptions cancel the
reader before releasing its lock. A read rejection retains its original value,
including undefined or null. The caller's exception still wins if cancellation
also rejects, following the language's async iterator closing rules.

The byte conversion and bodyUsed paths remain unchanged. Generic body producers
still use the existing fromAsyncIterable adapter. Bun's stream conversion, shell
collection and node:stream/consumers are not changed by this body-only fix.

The regression uses real native ReadableStreams with values and
Symbol.asyncIterator shadowed, and the actual body and web factories. It checks
Request and Response data, bodyUsed, locked bodies, read errors, chunk boundaries,
early return, cancellation and consumer errors. The portable page and worker
probe compares baseline and candidate factories with untouched and adapted host
constructors. Missing iterator support on iOS and the original Nuxt throwing site
must be measured there; local reproduction alone does not establish that cause.
