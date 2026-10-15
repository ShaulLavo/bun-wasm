# Bun dev server port

Status: Approved. Slice 1 implements uncompressed WebSockets. HTML serving,
incremental bundling and the sandbox migration are still pending.

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

## Verify

Build all three wasm artifacts first, using the project's memory cage and
private Cargo targets. Then run:

```sh
source env.sh
scripts/test.sh --no-build
scripts/test.sh --no-build --engine browser
scripts/test.sh --no-build --engine jsc
node scripts/test-websocket.mjs
ENGINES=browser,quickjs,jsc scripts/test-web.sh
```

`BUN_WASM_LAUNCHER` selects the launcher used by `test-websocket.mjs`.
The test checks each engine against Node's native WebSocket client and a raw
TCP peer. It covers binary data, 80 KB UTF-8 text, subprotocol negotiation,
HTTP takeover with a frame arriving alongside the upgrade, fragmented UTF-8
with interleaved ping, and six malformed-frame cases. It closes its own
sockets and kills and reaps its child processes on completion or failure.

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

## Next slices

2. Route HTML entries through Bun's HTML bundler. The CLI currently treats
   `index.html` as a normal entry, and the runtime classifies HTML as text.
   Implement both direct HTML entries and imported HTML route objects before
   changing the sandbox template.
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
