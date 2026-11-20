# Streamed Bun.serve request bodies

Class **Runtime feature**, **original adapter** in `crates/bunwasm-runtime/src/js/net.js`
(`serveHttp`) and the new `crates/bunwasm-runtime/src/js/serve_request_body.ts`. No
upstream code is copied or adapted. The behavioral reference is Bun's server at revision
`9510e74152073d850a18758ca41114d8f214ffa6` (`src/runtime/server/RequestContext.rs`,
`on_abort`, and `test/js/web/fetch/body.test.ts`, "rejects when the client aborts
mid-upload server-side"), checked against native Bun 1.4.4.

Before this change `Bun.serve` waited for a request's whole body before it called the
handler. Bun calls the handler once the head has arrived and lets it read the body as it
comes. Now, when the head is complete but the body is not, the handler runs at once with
a byte stream body that the connection's data feeds through the same incremental decoder
the HTTP client uses (`http_body.ts`, Content-Length or chunked framing). A body that is
already complete with the head keeps the in-memory path. The next request on the
connection is parsed only after the streamed body ends, so keep-alive and pipelining keep
their order.

When the client goes away before the body ends (end of stream, a connection error, or the
server destroying the connection), the body stream errors with a `DOMException` named
`AbortError` ("The connection was closed."), as Bun aborts it with its connection-closed
reason, and reads in the handler reject with it. A malformed chunked body gets Bun's
`400 Bad Request` (`Connection: close`) and the connection closes; the handler's read fails
with the same `AbortError`. The shared decoder now rejects a chunk not followed by CRLF at
the first wrong byte, where it used to wait for a second byte that might never come. `node:http` servers are unchanged.

When the response goes out before the body ended, Bun aborts the body: a later read gets
the `AbortError`. The rest of the body is still read and dropped, so the connection serves
the next keep-alive request. While the handler leaves the body unread, the connection stops
reading once 256 KiB wait in the stream (the existing `canRead` hook), so an upload the
handler never reads is not held in memory.

The `serve-streamed-request-body` fixture compares this with native Bun.
