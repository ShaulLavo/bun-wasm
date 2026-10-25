# Fetch and serve request cancellation

Class **Host feature**, **original adapters** in
`crates/bunwasm-runtime/src/js/fetch_lifetime.ts`,
`crates/bunwasm-runtime/src/js/serve_request_lifetime.ts` and the top-level fetch
and Bun.serve dispatch regions of `src/js/net.js`. No upstream implementation
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
through response writing and are removed when that request finishes. A later
keep-alive request cannot abort a completed request. This adapter does not change
the HTTP flow classes or Waffle's networking protocol.

The factory regression uses the real Request, fetch, serve, connection and waiter
implementations with an in-memory host boundary. Native fixtures separately
exercise open-upload aborts and client-disconnect/server-stop cancellation.
The fixtures are also registered for supported-engine guest CI.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Fetch request body and header lifetime | Host feature | Original abort-aware reader and host-waiter ownership. |
| Serve request signal lifetime | Host feature | Original controller binding to existing connection callbacks. |

[Ledger scope and pinned revisions](scope.md).
