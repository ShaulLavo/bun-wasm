# Fetch and serve request cancellation

Class **Host feature**, **original adapters** in
`crates/bunwasm-runtime/src/js/fetch_lifetime.ts`,
`crates/bunwasm-runtime/src/js/serve_request_lifetime.ts` and the top-level fetch
and Bun.serve dispatch regions of `src/js/net.js`, plus the original native
reqwest binding in `crates/bunwasm-host/src/net/fetch.rs`. No upstream implementation
is copied or adapted. Native Bun 1.4.4 and Node 26.12.1 are behavioral references
for abort-reason identity. Native Bun 1.4.4 supplies the server-disconnect reference.

Fetch buffers request bodies as before. Its reader now observes cancellation
while the producer is open, cancels once with the exact signal reason, releases
the reader without waiting for asynchronous producer cleanup, and detaches its
listener on every exit. A second signal check prevents host dispatch after body
completion races an abort. The header waiter removes itself on abort, failure
or completion and shares the fetch operation's idempotent host-handle cleanup.
This adds no streaming-upload API or transport behavior.

Each dispatched server request owns a controller linked to the existing
connection close and EOF callbacks. Connection errors and forced server shutdown
therefore abort the active Request with AbortError. The callback bindings last
through response writing, including finite bytes still queued after the handler
returns. The adapter waits for the existing Connection `onDrain` callback when
`bufferedAmount` is nonzero, or releases that wait on request cancellation.
It restores the drain and cancellation callbacks on exit. A later keep-alive
request cannot abort a completed request, and an upgrade hands ownership to the
WebSocket immediately. Graceful stop rechecks keep-alive after queued output
finishes instead of dropping an apparently idle response or retaining the stopped
connection. This adapter does not change the HTTP flow classes or Waffle's
networking protocol.

The factory regression uses the real Request, fetch, serve, connection and waiter
implementations with an in-memory host boundary. It covers blocked and partial
finite writes, disconnect/EOF/forced stop before drain, streamed cancellation,
keep-alive isolation after drain and graceful stop with queued output. All belong
to the existing runtime-fetch-lifetime check manifest. Native fixtures separately
exercise open-upload aborts and client-disconnect/server-stop cancellation.
The fixtures are also registered for supported-engine guest CI.

The Request-copy source fixture registers the real `fetch_lifetime` factory
against the same internal object initialized by `web.js`. This supplies the real
body conversion and concatenation helpers when copied requests reach fetch. Both
native-stream and polyfill-stream controls retain their original assertions and
single runtime-request-copy manifest owner. The fixture adds no replacement
cancellation implementation or VM globals.

The native launcher previously marked a closed fetch handle as aborted without
interrupting reqwest's blocking send. A client waiting for response headers kept
its socket open, so the unchanged compiled server-disconnect fixture could not
observe a real disconnect. The binding now waits on reqwest's asynchronous send
and response-chunk futures with the request's own cancellation flag and waker.
Closing that handle wakes its pending operation and drops the future and response.
The shared reqwest pool uses one Tokio I/O worker, while the existing per-request
threads retain the synchronous decoders and bounded body queues. Redirect policy,
header handling, TLS and compression still use the same implementations. This
changes no host ABI or Waffle transport, adds no upload API or timeout, and leaves
the accepted guest request/response lifetime code and fixtures unchanged.

Native Rust regressions hold an actual localhost peer open before headers and
with an incomplete response body. Closing only the fetch handle must produce
peer EOF and remove the handle once. A concurrent-request control verifies that
cancelling one request does not cancel another using the shared client. These
unit tests run under the existing Rust workspace gate; the existing native fixture
manifests continue to own the two unchanged guest cancellation fixtures.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Fetch request body and header lifetime | Host feature | Original abort-aware reader and host-waiter ownership. |
| Serve request signal lifetime | Host feature | Original controller binding to existing connection callbacks. |
| Native fetch cancellation | Host feature | Original abort-aware waits around reqwest futures, retaining its pool and the existing decoder/queue path. |

[Ledger scope and pinned revisions](scope.md).
