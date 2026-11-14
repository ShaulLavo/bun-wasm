# TextDecoder native codec binding

The shared `TextDecoder` delegates label resolution and incremental decoding to
the existing `streams.decoder`, `streams.push` and `streams.release` operations
in `crates/bunwasm-runtime/src/streams.rs`. These operations use `encoding_rs`.
The former JavaScript label map and UTF-8 tail heuristic bypassed that codec,
rejecting supported encodings and losing UTF-16 bytes and surrogate state.

`text_decoder.ts` is an original bun-wasm adapter. It validates WebIDL options
dictionaries before changing stream state, reads input bytes after the `stream`
getter, and attaches Bun's encoding error codes. Completed or failed native calls
release their handle. A finalizer releases an abandoned decoder. The adapter
removes a Unicode BOM only after decoding succeeds, so a fatal chunk does not
consume the stream's first output code point. Each completed stream resets that
serialization state. The native codec implementation and public ABI are unchanged.

The single-byte test vectors come from Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`,
`test/js/web/encoding/text-decoder-single-byte.test.ts`. They are condensed into
data shared by the source-factory controls and native guest fixture. The streaming,
fatal and dictionary controls adapt cases from that revision's
`test/js/web/encoding/text-decoder.test.js`. No Bun implementation is copied.

| Source | Class | Local change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/text_decoder.ts` | Host feature | Original typed adapter over the existing native codec. |
| `crates/bunwasm-runtime/src/js/web.js` | Host feature | Install the typed decoder factory instead of the stateless implementation. |
| `tests/fixtures/text-decoder/` | Test adaptation | Condense upstream encoding vectors and state regressions for every guest engine. |
| `scripts/text-decoder-controls.ts`, `scripts/text-decoder.test.ts` | Test adaptation | Execute the full production Web factory with a native decoder boundary and check output, options, errors and handle cleanup. |

`checks/web-text-decoder.json` owns the source-factory regression, including the
local runtime preflight. `checks/native-text-decoder.json` owns the guest fixture.
The source controls use native Bun as the codec oracle. The guest fixture checks
the complete Rust binding on the existing native CI engines. Private JSC string
storage hooks and worker subprocess behavior are outside this correction.
