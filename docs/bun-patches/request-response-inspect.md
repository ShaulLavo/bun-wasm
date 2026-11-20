# Request and Response in Bun.inspect

Class **Runtime behavior**, **original adapter** in `crates/bunwasm-runtime/src/js/inspect.js`
(`printFetchBody`) and `web.js` (`fetchInspectView`). No upstream code is copied; the
layout follows Bun's `write_format` in `src/runtime/webcore/Response.rs` and `Request.rs`
and its size formatter `bun_core::fmt::size` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4.

`Bun.inspect` and `console.log` printed a Request or Response as a plain object, internal
fields included. They now print what Bun prints: `Response (<size>) {` with `ok`, `url`,
`status`, `statusText`, `headers`, `redirected` and `bodyUsed` (a Request: `method`, `url`
and `headers`), then what backs the body: `Blob (<size>)`, with its type when it has one,
or the body stream once something took it through the `body` getter. Headers list common
names first, as Bun's header storage does.

The size is the body's byte length while the bytes are in memory, `0 KB` once the body is
used or handed out as a stream, and for a fetched Response the Content-Length until the
body is used (`body.test.ts`, "a fetch() Response still reports the Content-Length after
.body created the stream"). Native Bun 1.4.4 still prints `0 KB` after `.body` on a
fetched Response; the suite revision expects the Content-Length, and this follows the
suite.

A body stream itself prints with the runtime's existing stream formatter, which lists
fewer members than Bun's.

The `response-inspect` fixture compares this with native Bun.
