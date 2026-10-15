# Bun dev server port

Status: Approved. Slices 1 and 2 implement uncompressed WebSockets and bundled
HTML serving. Incremental bundling and the sandbox migration are still pending.

## WebSockets

`Bun.serve({ fetch, websocket })` supports `server.upgrade(request, { data,
headers })`, text and binary messages, `open`, `message`, `close`, `error`,
`ping`, `pong` and `drain` callbacks. Sockets have topic subscriptions and
publishing, close handshakes and termination. `server.pendingWebSockets` and
`server.subscriberCount(topic)` reflect the live connections. Server binary
messages default to Buffers; `arraybuffer` and `uint8array` are also supported.

The global `WebSocket` client supports `ws://` and `http://` URLs, custom
headers and subprotocols, Blob sends, binary types, ping and pong events, and
asynchronous close events. It validates the server's accept key and selected
subprotocol. Both ends reject invalid masking, control frames, continuation
sequences, close codes, UTF-8 and oversized messages. Server
`websocket.maxPayloadLength` defaults to 16 MiB. The client has the same limit.

`crates/bunwasm-runtime/src/js/websocket.js` implements framing next to the
existing HTTP parser in `net.js`. Frames use the existing host TCP slots,
so `crates/bunwasm-host` and Node's networking adapter need no new imports or
protocol. Keeping live callbacks, buffers and HTTP takeover in the same JS
layer also avoids copying each payload through the Rust value codec on the
host engine.

In browser workers, clients can connect to the guest's own listeners through
`NetHost`'s existing local pipes. `NetHelper.connect(port, sink)` adds a raw
duplex connection for a future preview WebSocket tunnel. Writes retain their
order across ring records and copy input bytes before queuing them. Ordinary
HTTP preview requests use this connection underneath `ResponseParser`.

This slice does not provide the preview-page WebSocket shim. A WebSocket opened
by a separate preview tab still cannot reach a guest listener. That bridge
belongs to slice 3.

TLS, proxies, Unix sockets and permessage-deflate are not implemented. The
client does not offer compression and rejects unsolicited extensions. TLS
server options are rejected rather than silently serving plaintext. Browser
workers cannot open arbitrary external TCP connections. Idle timeout,
backpressure limits, pause/resume and detailed Bun error-message compatibility
remain outside this slice.

## HTML entries and routes

`bun ./index.html` starts an HTTP server, using `BUN_PORT` or `PORT` to select
its port. Port `0` selects a free port. Imported HTML files produce HTMLBundle
objects, so `Bun.serve({ routes: { "/": html } })` works on every engine.
Method-specific HTML routes are supported too. HTML routes serve GET and HEAD
and answer other methods with 405.

`html_server.js` calls Bun's real HTML bundler and serves its in-memory outputs.
Bun parses HTML, bundles JavaScript and CSS, resolves packages, rewrites asset
URLs and emits assets. The runtime does not parse HTML or rewrite module
imports. Responses retain their content types and lengths. Direct HTML CLI
entries fall back to their HTML for client-side routes; exact imported routes
still return 404 for unmatched paths.

The module loader distinguishes HTML from text through `modules::Format::Html`.
All engines share the HTMLBundle factory and route handling in the JS runtime.
Single-entry HTML builds now allow multiple in-memory outputs, and build
artifacts derive their MIME types from their output paths. No generated build
directory is written into the project.

This is a static serving slice. It uses Bun's ordinary HTML bundler, not bake's
incremental graph. `development.hmr` does not enable updates yet. Syntax errors
are reported by the existing server error path, without a browser overlay.

## Verify

Build all three wasm artifacts first, using the project's memory cage and
private Cargo targets. Then run:

```sh
source env.sh
scripts/test.sh --no-build
scripts/test.sh --no-build --engine browser
scripts/test.sh --no-build --engine jsc
node scripts/test-websocket.mjs
node scripts/test-html-server.mjs
ENGINES=browser,quickjs,jsc scripts/test-web.sh
```

`BUN_WASM_LAUNCHER` selects the launcher used by `test-websocket.mjs`.
The test checks each engine against Node's native WebSocket client and a raw
TCP peer. It covers binary data, 80 KB UTF-8 text, subprotocol negotiation,
HTTP takeover with a frame arriving alongside the upgrade, fragmented UTF-8
with interleaved ping, and six malformed-frame cases. It closes its own
sockets and kills and reaps its child processes on completion or failure.

`test-html-server.mjs` starts each engine with a direct HTML entry and checks
HTML, bundled JavaScript, CSS, an emitted image, HEAD, method rejection and
client routing. The `net-serve-html` fixture checks imported HTML routes,
method-specific routes and in-memory HTML build output. Browser tests render
a direct HTML entry and check its CSS through the service-worker preview.

The `net-websocket` fixture checks guest-to-guest echo, subscriptions,
large messages and close handling. It also connects to the native Bun fixture
server to check outbound client framing and Blob ping events. Browser tests
exercise the same guest client and server over virtual TCP in Chromium and
WebKit, including the phone layout and a separate HTTP preview tab.

For the upstream subset, use a fixed launcher and the same dependency directory
for both the base commit and this branch:

```sh
scripts/bun-suite.sh --engine quickjs --jobs 2 --network loopback \
  --launcher "$launcher" --dependencies "$dependencies" --output "$output" \
  bake 'js/bun/http/*html*' js/web/websocket
```

Repeat for `browser` and `jsc`. This selects 65 files at upstream commit
`4ceda2c2868d3a7703c7737ddd9de7244ec384df`. A completed census can still contain
failing tests. The checked-in full-suite baseline is not regenerated here.

## Measured results

The controlled run compares base `cc5738b` with these two slices. Both runs use
the same copied native launcher, dependency directory, upstream revision,
loopback isolation, two workers and 15-second file deadlines.

| Engine | Before passes | After passes | Fully passing files before/after | Timeouts before/after |
|---|---:|---:|---:|---:|
| QuickJS | 2 | 67 | 0 / 3 | 1 / 0 |
| Browser | 15 | 61 | 1 / 3 | 2 / 0 |
| JSC | 2 | 66 | 0 / 3 | 1 / 0 |

Each run selects 65 files. The after-runs still report 217, 223 and 218 failed
observed tests respectively, seven skips and 29 errors. Most bake tests still
stop at unsupported runtime or subprocess APIs. These are compatibility
measurements, not a passing upstream suite. The one-pass QuickJS/JSC difference
is the upstream `instances should be finalized when GC'd` test; the portable
heap statistics do not prove object finalization.

All 69 local fixtures pass on each engine. The external WebSocket checks pass
72 checks across the engines. Direct HTML CLI checks pass on all three, and
the full web checks pass in Chromium and WebKit with every engine, including
HTML rendering, linked CSS and phone layout. The existing sandbox HMR
checklist also passes all six browser/engine combinations. That checklist
still exercises the existing `.dev/` server; it does not establish that Bun
HMR has been ported. A close-timer regression test fails before the write-error
cleanup fix and passes after it.

Raw results and logs are retained in
`/work/tmp/bun-wasm-real-dev-server-results/` for coordinator review. The
`baseline-*.json` and `measured-*.json` files hold the controlled comparison.
The coordinator owns those results and the review worktree until integration,
then removes them.

## Next slices

3. Port the incremental graph and bundler callbacks from
   `vendor/bun/src/runtime/bake/DevServer.rs` and `dev_server/`. Replace the
   trapping bake hooks in `crates/bunwasm-build/src/stubs.rs`. Serve Bun's
   `hmr-runtime-client.ts` and its protocol, then connect preview tabs through
   `NetHelper.connect`. Choose and document the page-to-worker file-change
   notification when adding the watcher.
4. Enable Bun's React refresh and error overlay, then remove the sandbox's
   `.dev/` plumbing. Preserve engine switching, dependency caching, preview
   links and phone behavior. Run the existing HMR acceptance test on all engines.
5. Add a vanilla TypeScript template that exercises `import.meta.hot`, and an
   HTML CLI fixture with an HMR WebSocket client.
