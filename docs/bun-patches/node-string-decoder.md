### Node string decoder

`crates/bunwasm-runtime/src/js/string_decoder.ts`. Class **Port**. Upstream Node `src/string_decoder.cc` at the Node comparison revision. The import revision is not recorded.

Translate the buffered/missing-byte state machine into TypeScript using a four-byte `lastChar`, `_buffered`, and `_missing`. Preserve UTF-8 continuation handling, UTF-16 surrogate tails, base64 groups, and flush behavior. Replace native buffers and binding calls with the local Buffer factory, and expose the StringDecoder methods and state getters. This handles split characters without Node's native decoder. The file was renamed from JavaScript with strict types; its encoding names form a closed union, the decoder's state fields are type-only `declare` fields, and the logic is unchanged.

The constructor is an ES5-style function, not a class, because Node's `lib/string_decoder.js` declares `function StringDecoder(encoding)` and Bun's native constructor at revision `9510e74152073d850a18758ca41114d8f214ffa6` accepts the same calls. `new` and subclasses build an instance of `new.target`, including through `Reflect.construct` with an unrelated, `Object` or Proxy target. A call with an object receiver, as in `StringDecoder.apply(this, arguments)` from a `util.inherits` subclass, sets up that object. Any other call returns a new decoder. The methods live on a `Decoder` class whose prototype is the function's `prototype`, and the function takes rest parameters so its `length` is 0, as in Bun. The `string-decoder-call` fixture compares these cases with native Bun 1.4.4. One difference is left alone: native Bun rejects the `lastNeed` and `lastTotal` getters on a `util.inherits` subclass instance, while here they work.

`makeString` checks the projected output length (including any `prepend` from
pending buffered bytes) once against `MAX_STRING_LENGTH` (default `0x7fffffff`,
overridable via `internal.stringDecoderMaxLength` for allocation-free unit tests
in `scripts/string-decoder.test.ts`) before calling `Buffer.prototype.toString`,
throwing `ERR_STRING_TOO_LONG` instead of overflowing wasm memory or crashing on
oversized buffers (for example `Buffer.allocUnsafe(2 ** 31)` on the 64-bit
Browser host).

`Decoder.prototype.text(input, offset)` validates that `input` is an
`ArrayBufferView` first, coerces `offset` once as a signed 32-bit integer, reads
the view's live intrinsic byte range through `buffer_source.viewBytes` after
coercion, and returns `""` when `offset < 0` or `offset >= bytes.length`. It
deliberately preserves pending buffered state (`_missing` / `_buffered`),
matching Bun's `src/jsc/bindings/JSStringDecoder.cpp` at
`9510e74152073d850a18758ca41114d8f214ffa6` rather than Node's reset behavior.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/string_decoder.ts`](#node-string-decoder) | Port | Translate Node's chunk-decoder state machine to TypeScript. |
| `crates/bunwasm-runtime/src/js/string_decoder.ts`, `StringDecoder` constructor | Adapted implementation | Node's ES5 constructor shape, with Bun's `new.target` and call handling. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
