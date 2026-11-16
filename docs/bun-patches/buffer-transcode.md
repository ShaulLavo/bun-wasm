# Buffer transcoding

Class: Original adapter.

`crates/bunwasm-runtime/src/js/buffer_transcode.ts` implements the public
`node:buffer.transcode` export. No upstream implementation is copied. Comparison
sources are Bun `test/js/node/buffer.test.js` at
`9510e74152073d850a18758ca41114d8f214ffa6`, native Bun 1.4.4, and Node 26.12.1.

The adapter normalizes supported encoding aliases through the existing Buffer
helper and delegates Unicode decoding to the existing TextDecoder implementation.
It converts malformed input with the same substitution or strict-conversion
policy as native Bun. Narrow output writes one replacement byte per Unicode code
point. ASCII-to-UTF-16 preserves the native widening behavior, while an odd final
UTF-16 byte is replaced for UTF-16 output and discarded for narrow output. Strict
UTF-8/UTF-16 conversions report ICU-style error codes and numbers. Empty input
returns an empty Buffer before encoding validation, matching both native oracles.

Bun preserves a leading Unicode BOM when converting to ASCII or latin1; the
observed Node release discards it in those conversions. The adapter follows Bun.
Existing codecs, native backing allocation, heap limits, and shared-memory
capabilities are unchanged. Large-input upstream allocation prerequisites remain
separate from demonstrated transcoding behavior.

`scripts/buffer-api-contract.test.ts` loads the production factory and emitted
helper. `tests/fixtures/buffer-api-contract` exercises the public module through
QuickJS, JSC, Browser, and SpiderMonkey using feature-owned check manifests.
