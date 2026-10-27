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
TypeScript helper, which captures the producer during construction. Together
with the dispatch check, this preserves native Bun's two synchronous iterator
getter reads, receiver and acquisition exceptions. The producer and its next
method are validated at construction. A zero high-water mark keeps next()
invocation lazy until consumption. Reads convert text and buffer chunks with the
existing native encoder and byte conversion. Cancellation calls the producer's
return() independently of an outstanding next(), marks the body closed first,
and ignores late results. Conversion failure closes the producer while retaining
the original error. Source and cancellation errors preserve their original
identities, including falsy reasons.
The existing clone, consumption and bodyUsed paths continue to own the resulting
stream. Ordinary object and synchronous-iterator string conversion is unchanged.

The regression uses the same asynchronous-iterator shape as the actual compiled
Astro output and exercises text, mixed bytes, clone, bodyUsed, cancellation,
original errors and invalid chunks. Native Node agrees on body data and errors;
its producer cleanup timing/behavior differs on the cancellation and invalid-chunk
controls. Those two fields are compared to native Bun, not normalized into a
claim of Node cleanup parity. The fixture is an original reduction.

Maintained lifecycle controls reuse the independent PR296 review reproducer.
They compare native Bun and the actual source factory for constructor ordering,
idle reads, separate-producer immediate cancellation, cancellation before a
pending next resolves, acquisition errors, chunk offsets, clone/lock behavior
and falsy errors. The pending producer is released in finally and all test waits
are bounded. Native Bun's eager clone read-ahead is not asserted; the existing
bounded tee behavior and buffer-reuse semantics remain unchanged.
