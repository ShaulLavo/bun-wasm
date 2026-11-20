# ReadableStream consumer methods and Body.textStream

Class: Original adapter.

Bun adds four reading methods to `ReadableStream.prototype`, `text()`, `json()`,
`bytes()` and `blob()`, in `src/jsc/bindings/webcore/streams/JSReadableStream.cpp`,
backed by `readableStreamToText` and its siblings in `BunStreamConsumers.cpp`,
and exposes `Bun.readableStreamToArray` from `BunObject.cpp`. Its Request and
Response also have `textStream()`, from `Body.rs` `to_text_readable_stream`. All
at revision `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native
Bun 1.4.4. No upstream code is copied.

`crates/bunwasm-runtime/src/js/readable_stream_methods.ts` defines the four
methods, and `bun.js` installs them on the runtime's `ReadableStream` when it
builds the Bun object: the polyfill's class on QuickJS, JSC and SpiderMonkey, and
the host's own `ReadableStream` on the Browser engine. `streams.ts` is unchanged,
so its pinned-syntax guard in `web/tests/runtime-streams.test.ts` still holds. Each reads every chunk, joins
string and byte chunks as UTF-8 bytes, then decodes, parses or wraps them. A
receiver that is not a ReadableStream throws `ERR_INVALID_THIS` synchronously; a
locked stream returns a promise rejected with `ERR_INVALID_STATE`, as in Bun.
The same reader backs `Bun.readableStreamToArray`, which returns the chunks
unchanged. Bun's
buffered and direct-stream fast paths are not reproduced; every stream is read
through its reader.

`textStream()` lives in `crates/bunwasm-runtime/src/js/body_streams.ts` and is
wired into the shared Request and Response body methods in `web.js`. It returns a
stream of decoded strings, holding back a character split across chunks until
it is complete. A null body gives an empty stream and leaves the body unused.
Otherwise the body becomes used, and a second call throws `ERR_BODY_ALREADY_USED`
(`Body is disturbed or locked`).

The text stream follows Bun's `SourceKind::TextDecode` source
(`readableStreamTextDecodeFrom` and the `textDecode*` steps in
`src/jsc/bindings/webcore/streams/ReadableStreamOperations.cpp`). It has a high-water
mark of 0, so nothing is read before the first read. It releases the source's reader
when the source closes (after the flushed tail), when the text stream is cancelled
(after passing the cancel on), and when the source yields a chunk that is not a
BufferSource. That chunk errors the text stream with Bun's `TypeError` ("Body.textStream()
received a chunk that is not a BufferSource") and cancels the source with it. The
source therefore ends unlocked in every case, as in Bun. ArrayBuffer and any view are
accepted, and a detached one reads as empty.

The `stream-consumer-methods` and `body-text-stream-release` fixtures compare all of
this with native Bun.
