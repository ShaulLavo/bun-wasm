<a id="bun-array-buffer-sink"></a>

### Bun ArrayBufferSink

Class **Port**. Upstream `src/runtime/webcore/ArrayBufferSink.rs`,
`src/runtime/webcore/streams.rs` and `src/runtime/webcore/Sink.rs` at Bun
`9510e74152073d850a18758ca41114d8f214ffa6`.

Translate the byte ownership, streaming flush, repeated end, restart and closed-sink behavior
to JavaScript typed arrays. Preserve the start option parser's own-property check, strict
boolean modes, numeric watermark detection and getter ordering before the live-sink check.
The closed-sink error text comes from `Sink.rs`.

The upstream module depends on `bun_jsc`, so it cannot be imported as an independent Rust
crate. Engine-owned buffers let every engine reclaim abandoned sinks without a new native
handle table or finalizer interface. String writes use the existing Rust UTF-8 encoder.
The watermark remains an allocation hint and causes no eager reservation in this adapter.
The callable constructor and private JavaScript storage are original binding adapters.
Detached backing stores produce an owned empty chunk before view bounds are read or a new view is constructed. Capture ArrayBuffer, SharedArrayBuffer, TypedArray and DataView intrinsic getters to extract the real backing buffer and
bounds before copying. Own properties and accessors cannot replace those internal slots.
This byte-view extraction is also an original binding adapter.
The unsupported GC-tuning member is absent from `Bun.unsafe`, so the upstream harness's
capability check can run byte-content tests without requesting unavailable GC controls.

The runtime adapter is now a strictly checked TypeScript factory. Its native UTF-8
encoder and byte concatenation contracts live in `src/js/runtime.d.ts`. The
intrinsic buffer/view getters are captured with checked accessor lookups; input
option fields remain unknown until their existing boolean/number checks narrow
them. Byte copies and sink lifecycle behavior are unchanged.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/array_buffer_sink.ts`](#bun-array-buffer-sink) | Port | Adapt Bun's byte sink lifecycle and option parsing to engine-owned typed arrays. |

[Parent context](bun-patch-series.md).
