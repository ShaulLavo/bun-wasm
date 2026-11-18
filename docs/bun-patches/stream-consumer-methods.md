# ReadableStream consumer methods and Body.textStream

Class: Original adapter.

Bun adds four reading methods to `ReadableStream.prototype`, `text()`, `json()`,
`bytes()` and `blob()`, in `src/jsc/bindings/webcore/streams/JSReadableStream.cpp`,
backed by `readableStreamToText` and its siblings in `BunStreamConsumers.cpp`,
and exposes `Bun.readableStreamToArray` from `BunObject.cpp`. Its Request and
Response also have `textStream()`, from `Body.rs` `to_text_readable_stream`. All
at revision `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native
Bun 1.4.4. No upstream code is copied.

`crates/bunwasm-runtime/src/js/streams.ts` installs the four methods on the
stream class it returns: the polyfill's on QuickJS, JSC and SpiderMonkey, and the
host's own `ReadableStream` on the Browser engine. Each reads every chunk, joins
string and byte chunks as UTF-8 bytes, then decodes, parses or wraps them. A
receiver that is not a ReadableStream throws `ERR_INVALID_THIS` synchronously; a
locked stream returns a promise rejected with `ERR_INVALID_STATE`, as in Bun.
The same reader backs `Bun.readableStreamToArray`, which `bun.js` reaches through
`internal.readableStreamToArray` and which returns the chunks unchanged. Bun's
buffered and direct-stream fast paths are not reproduced; every stream is read
through its reader.

`textStream()` lives in `crates/bunwasm-runtime/src/js/body_streams.ts` and is
wired into the shared Request and Response body methods in `web.js`. It returns a
stream of decoded strings, holding back a character split across chunks until
it is complete. A null body gives an empty stream and leaves the body unused.
Otherwise the body becomes used, and a second call throws `ERR_BODY_ALREADY_USED`
(`Body is disturbed or locked`).

The `stream-consumer-methods` fixture compares all of this with native Bun.
