### Web stream inspection

`crates/bunwasm-runtime/src/js/stream_inspect.ts` installs `[Symbol.for("nodejs.util.inspect.custom")]` on the seventeen web stream classes, so `util.inspect`, `Bun.inspect` and `console.log` print Bun's summary, for example `ReadableStream { locked: false, state: 'readable', supportsBYOB: false }`. Before this, QuickJS and JSC printed the WHATWG ponyfill's internal fields (`<ref *1> A [ReadableStream] { _state: 'readable', ... }`), and the Browser engine under Node used Node's own methods, which return `undefined` for `depth < 0` and throw on another receiver.

It adapts Bun's `Bun::WebStreams::customInspect` (`src/jsc/bindings/webcore/streams/WebStreamsInspectCustom.cpp`) and the per-class `inspectCustom` functions in the same directory's `JS*.cpp` files, at Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`, reimplemented in TypeScript. No code is copied. As in Bun:

- `depth < 0` returns the receiver, and the inner `util.inspect` gets a copy of the options with `depth - 1`, or `null` when no depth is given.
- Another receiver returns itself, so the formatter falls back to default output. `TextEncoderStream`, `TextDecoderStream`, `CompressionStream` and `DecompressionStream` throw `ERR_INVALID_THIS` instead.
- The printed name is the class name, not a subclass's.
- The method is writable, configurable and not enumerable, with length 2.

Each class shows the fields Bun shows: `locked`, `state` and `supportsBYOB` for ReadableStream; `stream`, the request count and `close` for the readers; nothing for the readable controllers; `view` and `controller` for a BYOB request; `locked` and `state` for WritableStream; `stream`, `close`, `ready` and `desiredSize` for the writer; `stream` for the writable and transform controllers; `readable`, `writable` and `backpressure` for TransformStream; `highWaterMark` for the strategies; and the public getters of the four transform wrappers.

On QuickJS, JSC and the other ponyfill engines the values come from the ponyfill's `_`-prefixed fields, branded by the same own field its `IsReadableStream` and related checks use. On the Browser engine the classes are the host's. Under Node, the values come from each instance's own `kState` symbol, which Node's own inspector reads. A browser exposes no stream state, so there ReadableStream, WritableStream, TransformStream, the readers, the writer, the BYOB request and the writable and transform controllers keep the default formatting. The strategies, the readable controllers and the four transform wrappers use public getters and print Bun's form on every host.

Bun's native instances have no own properties, so a stream nested past the depth limit, or inspected with `customInspect: false`, prints `ReadableStream {}`. The ponyfill's instances and Node's have own fields. `stream_inspect.ts` marks each prototype with the non-enumerable `Symbol.for("bunwasm.inspect.noOwnKeys")`, and `getKeys` in `inspect.js` returns no keys for an instance that inherits the marker. The prototype itself keeps its keys.

`stream_inspect.ts` also restores the ponyfill constructors' names. The bundle is minified, so `ReadableStream.name` was `"A"`, and default formatting printed `A [ReadableStream]`.

One native Bun quirk is not copied: `Bun.inspect` of a multi-line result nested in an array does not re-indent it in native Bun. Here the existing formatter's handling applies. The `web-stream-inspect` fixture compares the output with native Bun 1.4.4 on QuickJS, JSC and Browser.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/stream_inspect.ts` | Adapted implementation | Bun `WebStreamsInspectCustom.cpp` and the stream classes' `inspectCustom` functions at `9510e74152073d850a18758ca41114d8f214ffa6`, reimplemented over the ponyfill fields and Node's `kState`. |
| `crates/bunwasm-runtime/src/js/bootstrap.js`, `stream_inspect` load | Host feature | Install the methods with the globals. |
| `crates/bunwasm-runtime/src/js/inspect.js`, `hidesOwnKeys` | Host feature | Leave out the own fields of marked stream instances, as native instances have none. |
| `crates/bunwasm-runtime/src/js/stream_inspect.ts`, constructor names | Host feature | Name the minified ponyfill classes after their exports. |

[Ledger scope and pinned revisions](scope.md).
