# Bun dev server port

Status: Approved. Slices 1–4 implement WebSockets, HTML serving, Bun bake
incremental HMR, React refresh and the plain-app sandbox. Slice 5 adds a
second template.

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

Slices 1–2 did not provide a preview-page WebSocket shim. Slice 3 adds the
bridge described below, including independent preview tabs.

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
artifacts derive their MIME types from their output paths, and emitted assets
report the file loader. No generated build
directory is written into the project.

Slices 1–2 used Bun's ordinary HTML bundler for static serving. Slice 3 adds
bake's incremental graph and client for development HTML entries. Static routes
continue to use the ordinary bundler when development is disabled.

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
| QuickJS | 2 | 66 | 0 / 3 | 1 / 0 |
| Browser | 15 | 61 | 1 / 3 | 2 / 0 |
| JSC | 2 | 67 | 0 / 3 | 1 / 0 |

Each run selects 65 files. The after-runs still report 218, 223 and 217 failed
observed tests respectively, seven skips and 29 errors. Most bake tests still
stop at unsupported runtime or subprocess APIs. These are compatibility
measurements, not a passing upstream suite. The upstream `instances should be finalized when GC'd`
test varied by one pass between repeated QuickJS and JSC runs. The portable
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

3. Complete. See the slice 3 implementation and verification below.
4. Complete. See the slice 4 implementation and verification below.
5. Add a vanilla TypeScript template that exercises `import.meta.hot`, and an
   HTML CLI fixture with an HMR WebSocket client.

## Slice 3: incremental bake on WASI

The frontend now compiles Bun's unchanged `incremental_graph.rs`, `packed_map.rs`
and `serialized_failure.rs` against a host-independent owner in
`crates/bunwasm-build/src/dev_server`. `BundleV2::start_from_bake_dev_server`
parses stale entries, its normal bake callbacks index emitted modules and their
edges, and its cache hook skips clean modules. The WASI patch only exposes the
existing parse/finish sequence to the synchronous mini event loop.

The generated client is Bun's `hmr-runtime-client.ts`, `hmr-module.ts` and
supporting overlay/CSS/runtime modules. Regenerate it with
`scripts/generate-bake.sh`; `--check` compares the checked-in output. The runtime
serves that client's native module registry and binary HMR protocol on
`/_bun/hmr`. `scripts/test-hmr-server.mjs` edits a real CLI file and checks the
version/subscription handshake, changed module payload, refreshed HTTP bundle,
Bun's serialized syntax error and recovery on each engine.

Filesystem delivery uses a shared filesystem on the CLI and byte snapshots of
known project inputs every 100 ms. Browser editors call
`NetHelper.changeFile(path, bytes)`; ordered records in the existing shared ring
atomically replace the worker's MemFS file before the same watcher runs. This
also works while QuickJS or JSC is blocked inside wasm. Dependency files are
excluded from periodic polling. Missing-import directory watching is not yet
implemented.

The service worker adds a WebSocket shim to preview HTML. The shim reuses the
runtime's existing WebSocket framing and handshake implementation. A transferred
MessagePort finds the owning page through the service worker and connects to
`NetHelper.connect`, so independent preview tabs use the same guest TCP listener.
External WebSockets retain the browser's own implementation. HTML previews carry
the host's isolation headers so they can render inside an isolated editor page.

Only one HTML root per HMR listener is currently represented by route zero.
Static `development: false` HTML routes retain their ordinary bundler path.
Source maps are retained in the incremental graph, but their HTTP endpoints are
not yet exposed. React refresh and sandbox migration are described in slice 4 below.

Verification at this boundary: 76 local fixtures pass on each engine. CLI HMR
and direct HTML checks pass on all three. Real Chromium and WebKit checks cover
both iframe and independent-tab updates, same-size source edits, document
identity across updates, linked CSS, binary sockets, protocol negotiation and
shared-ring filesystem writes. The full `scripts/test-web.sh` also passes.

## Slice 4: React refresh and the plain sandbox

The framework projection now enables Bun's built-in React refresh transform
when `react-refresh/runtime.js` is installed. The initial graph includes that
runtime and Bun's client loads it before the application's HTML entry. Bun's
own module runtime handles refresh boundaries; the sandbox adds no refresh
registry or custom module loader.

The sandbox template contains `index.html`, `src/main.tsx`, `src/App.tsx`,
`src/App.css` and `package.json`. It runs `bun ./index.html`. Editor saves use
the shared filesystem channel from slice 3. The engine picker, preview link,
independent tab and phone layout remain. The shared phone test writes its
layout sample directly to xterm, removing its dependency on `.dev/dev.ts`.

The HMR upgrade hook follows Bun's origin policy: matching hosts, localhost
names and non-browser clients without Origin are accepted; unrelated and
opaque origins are rejected. The HTML fixture checks these cases on each engine.

Bun's generated error runtime handles a page first opened with invalid source;
it receives the same serialized failures and configuration prelude as native
Bun. The regular client displays errors from later edits and clears them on
recovery. The acceptance test covers both cases.

Compiled dependency caching persists emitted package modules, graph edges and
complete packed source maps. The first visit compiles them with bun.wasm. The
page saves `/_bun/deps-cache` in Cache Storage and restores it to
`/.bunwasm/deps-cache` before a later run. The key includes the exact engine
wasm and template builds. Manifest/dependency edits disable restoration. The
cache reader validates its input before changing the graph, and corrupt caches
are discarded and rebuilt. Packages depending on project source, CSS or assets
are excluded from this cache.

`scripts/test-dev-cache.mjs` compares cold/warm JavaScript and cache bytes,
breaks the dependency sources to prove warm parser bypass, then edits the app
and checks the native HMR message. It also tests malformed cache records and
an empty cache. Run it with `BUN_WASM_LAUNCHER` as for the other CLI checks.

At the slice 4 boundary, all six browser/engine combinations pass nine React
acceptance steps, including state-preserving edits, CSS, both error-overlay
paths, independent tabs, engine switching and phone/clipboard behavior. All
six cache runs pass cold compilation, cached Restart/reload, HMR after restore,
corruption recovery and manifest invalidation. The CLI cache checks pass on
all three engines, including 36 malformed-cache cases and three empty caches.
