# Async iterable response bodies

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `src/js/body_streams.ts` and the body dispatch in `src/js/web.js` under `crates/bunwasm-runtime` | Original adapter | Consume asynchronous body iterables through a byte-producing ReadableStream. |

No upstream implementation is copied or patched. The API behavior is measured
against native Bun1.4.4 and Node26.12.1. The consumer reference is Astro5.14.1's
`dist/runtime/server/render/astro/render.js`, archive SHA256
`431847e15fced59b4cac46d68cf0dd2d6e7e0c6e29fa1ac0b70834bb063b056f`.
Its Node rendering path passes an async iterable of Uint8Array chunks to Response.
The previous adapter converted that object to the literal `[object Object]`.

The existing body extractor recognizes the async iterator and delegates to the
TypeScript body-stream helper. An async generator converts text and buffer chunks
with the existing native encoder and byte conversion, preserves source errors,
and closes the producer when consumption is cancelled or conversion fails.
The existing clone, consumption and bodyUsed paths continue to own the resulting
stream. Ordinary object and synchronous-iterator string conversion is unchanged.

The regression uses the same asynchronous-iterator shape as the actual compiled
Astro output and exercises text, mixed bytes, clone, bodyUsed, cancellation,
original errors and invalid chunks. Native Node agrees on body data and errors;
its producer cleanup timing/behavior differs on the cancellation and invalid-chunk
controls. Those two fields are compared to native Bun, not normalized into a
claim of Node cleanup parity. The fixture is an original reduction.
