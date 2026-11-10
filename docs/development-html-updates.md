# Development HTML updates

The generic development HTML adapter updates author-changed text and safe attributes without navigating or replacing the document. Application code does not import a client or change its template. The hot-server owner attaches the adapter only to an actual eligible `bun --hot run` server. Non-hot serving, production, `development: false` and `development: { hmr: false }` must not attach it.

## Update behavior

A committed server revision reaches the page through a private WebSocket on that listener. The page fetches its existing path and query with same-origin credentials, no-store caching and redirects disabled. No timer polls for changes or reconnects a disconnected page.

The client compares the last applied author HTML with the new author HTML. It writes only changed fields. Unchanged counter output, disabled state, form values, focus and listeners stay with their original live nodes. The original Window, Document, root, head and body stay in place. Executable scripts run through normal initial parsing once. The client never replays them.

The first subset requires unchanged node topology and IDs, unchanged scripts and import maps, and unchanged navigation/security policy. Script changes, new or removed nodes, duplicate IDs, changed doctypes, custom or shadow-tree updates and concurrent application edits to an affected field reject the whole patch. They do not cause a reload. Fixed-URL script and asset edits are not asset HMR. Author-changed image or stylesheet URLs use normal browser loading.

## Response limits

Only HTTP 200 GET HTML with already-buffered application bodies can enroll. Original author HTML is limited to 256 KiB. Genuine application streams and async iterables pass through before any body lock or read, even if they never finish. Wire chunking of a buffered body is not an application stream.

UTF-8 decoding is fatal on invalid bytes. Unsupported declared encodings, CSP headers or meta policies, base elements, refresh directives, range responses, attachments, encoded bodies, JSON and error responses remain unchanged. Transformed HTML explicitly declares `text/html; charset=utf-8`, removes stale body validators and uses no-store. Application cookies keep their original multiplicity.

The initial inert JSON bootstrap carries the original author baseline, escaped against script termination. The client removes that bootstrap after parsing. It retains one detached author tree, one live-node correspondence and at most one abortable candidate. Raw update responses carry immutable request stamps and original application policy metadata, not preview-added isolation headers.

## Lifetime and integration

`dev_html` exports `attach({ server, revisions })`. The server capability supplies its existing `port` and `upgrade(request, { data })`; `revisions` is `BunWasm.HotCommittedRevisions`. The returned adapter supplies `respond`, `upgrade`, `websocket`, `decorate` and idempotent `dispose`.

The server integration dispatches reserved HTTP and upgrade requests after Request-to-connection registration but before selecting an application graph. It keeps the composed WebSocket handlers across reloads and passes each response's captured request stamp to `decorate`. Adapter disposal terminates only private sockets, never the application listener. Private paths use the listener-instance token. Upgrade Origin must exactly match the request origin or the preview shim's exact virtual localhost origin and port.

A capture-phase pagehide suspends the client. Socket error/close becomes terminal in the next microtask, so an earlier Window-target shim listener cannot discard the baseline before suspension. Persisted pageshow creates one new subscription and catches up from its snapshot. Other disconnects and non-persisted pagehide release the socket, pending reader and retained trees. Old callbacks cannot resume a closed client. Each adapter caps private clients at 64, private outgoing buffered bytes at 4096 and private-only incoming frames at 1024 bytes. Pages accept revision frames at most 1024 characters.

`web/tests/dev-html-response.test.ts` and `web/tests/dev-html-client.test.ts` belong to the automatic Web test directory. `checks/web-browser-dev-html.json` registers the real-browser controls with the existing `web-browser` discovery owner. Passing these focused controls alone does not establish the guest filesystem-to-DOM gate or the maintained Hono matrix.
