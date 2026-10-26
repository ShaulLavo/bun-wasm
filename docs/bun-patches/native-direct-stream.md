# Native-host direct streams

| Class | Local source | Upstream contract | Change |
| --- | --- | --- | --- |
| Host feature | `web/src/native-direct-stream.ts`, constructor dispatch in `native-stream-state.ts` | Bun direct streams and ReactDOM 19.1.1's Bun renderer | Original adapter from measured native behavior. No upstream implementation copied. |

Bun is pinned to `9510e74152073d850a18758ca41114d8f214ffa6`.
Its direct controller lives in `src/jsc/bindings/webcore/streams/JSDirectStreamController.cpp`
and `.h`, with its contract described in `src/jsc/STREAMS.md`.
Those JSC bindings cannot run in the browser host.
ReactDOM 19.1.1 uses that controller in `cjs/react-dom-server.bun.development.js`,
lines 8684 to 8712, with a numeric byte high-water mark of 2048.

The original adapter uses a native default stream for reader state and delivery.
It adds lazy producer pulls, UTF-8 byte buffering, copied binary writes, shared
pressure promises, deferred delivery, and terminal settlement. Producers must
honor pressure promises to bound their retained output, as with native Bun.
A constructor sentinel dispatches only at the native source-type read, after
native strategy reads. Ordinary and byte streams keep native conversion order.
Direct streams require a numeric high-water mark rather than repeating an
observable numeric conversion. This is not a replacement for every Bun stream API.

The native reference is Bun 1.4.4, revision `38afee6c8`. Seven lifecycle controls
and exact React Unicode, large output, Suspense, and cancellation controls were
retained in the October 26, 2026 product-matrix report. Browser tests exercise
this adapter through the real runtime factory loader. They do not establish
an application pass or qualify a guest artifact.
