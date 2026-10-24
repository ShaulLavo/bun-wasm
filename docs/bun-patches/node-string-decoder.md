### Node string decoder

`crates/bunwasm-runtime/src/js/string_decoder.ts`. Class **Port**. Upstream Node `src/string_decoder.cc` at the Node comparison revision. The import revision is not recorded.

Translate the buffered/missing-byte state machine into TypeScript using a four-byte `lastChar`, `_buffered`, and `_missing`. Preserve UTF-8 continuation handling, UTF-16 surrogate tails, base64 groups, and flush behavior. Replace native buffers and binding calls with the local Buffer factory, and expose the StringDecoder methods and state getters. This handles split characters without Node's native decoder. The file was renamed from JavaScript with strict types; its encoding names form a closed union, the decoder's state fields are type-only `declare` fields, and the logic is unchanged.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/string_decoder.ts`](#node-string-decoder) | Port | Translate Node's chunk-decoder state machine to TypeScript. |

[Parent context](bun-patch-series.md).
