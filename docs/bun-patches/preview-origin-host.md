# Local root previews

Classification: original Bun consumer adapter. No upstream implementation copied
or adapted. It consumes Waffle's exported root-preview and dispatcher APIs.

## Run locally

Build the playground normally, then enable the loopback host:

```sh
source env.sh
PREVIEW_ORIGINS=1 bun web/serve.ts
```

Open the printed URL with `?root-previews`. Each virtual server gets a separate
loopback address and origin with its application at `/`. The maintained app harness selects
this setup with `scripts/app-matrix.sh --preview-origins` alongside its ordinary
options. Root mode requires the matching Waffle root-preview API.

The static hosting mode remains explicitly mounted. This adapter provisions no
DNS, TLS, credentials, deployment or public routes.

## Ownership and transport

`web/scripts/preview-owner-host.ts` serves the private owner endpoint.
A same-origin POST issues a one-use ticket with a 30-second lifetime. The owner
page presents it as a WebSocket subprotocol. Tickets are never cookies, query
parameters, application headers or public responses on a preview origin.
Bootstrap requires the owner host's exact Origin and authority. Foreign origins,
replayed tickets and unregistered control routes fail before dispatch.

`web/src/preview-owner-client.ts` adapts the private connection to Waffle's
`PreviewHostDispatcher` and `PreviewHostExchange`. Its Bun transport envelope
carries the published Open/Input/Output types unchanged, encoding byte buffers
for the native channel. It does not implement virtual HTTP or WebSocket framing.

`web/src/hosted-previews.ts` supplies `originForPort`, calls `bindHost`, and uses
the actual returned relay's dispatcher. Grants stay on the private owner channel.
Each registration captures one origin, runtime owner and virtual port. Another
owner, port, scheme or origin cannot replace that grant. The page runtime retains
the adapter as a consumer. Runtime revocation, page close and channel disconnect
close the relays, raw sockets and host listeners.

`web/preview-origin-host.ts` owns the native node:http listeners under Bun. It
preserves HTTP method, target, headers, bodies, status, cookies and cancellation.
It exposes the original upgrade request, already-read head bytes and raw socket
so Waffle receives the actual WebSocket handshake and duplex bytes.

The defaults bound the host to 128 lifetime origin allocations, 128 outstanding tickets or
connected owners, 16 ports per owner, 64 active exchanges across owners, 256 root
sockets across the host, 64 sockets per origin, 4 MiB request bodies/chunks and
8 MiB control frames/send queues. A root address is not shared with another owner or port, so cookies cannot cross
preview hosts. An old origin is never reassigned during a host lifetime. A late close cannot unregister a replacement binding.

Root mode skips the mounted preview service worker. The playground's independent
module scope and its isolation headers remain intact. Explicit mounted mode
continues to register its own lazy scope.

## Verification

Native host tests exercise authentication failures, fixed grants, real Waffle
HTTP and socket dispatch, body cancellation and teardown. The browser check uses
a real page runtime, real Waffle relay and fixed native Bun fixture. It covers
root paths/assets, history/reload, HTTP, raw WebSocket traffic, private grants,
port reuse, page close and runtime disposal. This fixture is independent of the
React Router application acceptance run.

`web/scripts/preview-port-sockets.ts` also serves literal loopback addresses for
registered virtual ports. An application opening `ws://127.0.0.1:<port>/path`
selects its runtime through its registered browser Origin, then that runtime's
fixed port grant. The same rule covers HTTP requests with an Origin header.
Other owners and unregistered ports fail before dispatch. Shared native listeners
retain separate owner/socket leases and close after the final owner releases them.
Native port conflicts fail without touching a pre-existing listener. No package
configuration, application URL rewriting, history patch or service-worker opener
is needed. This specifically covers generic extra server ports as well as the
primary port.

The harness's `preview-paths.ts` observer records only the actual first HTTP
request line sent into each virtual server connection. Original bytes, headers
and bodies are forwarded unchanged. Root-mode app results retain caller pathname
and those server request targets as independent path-agreement evidence.

The literal-port pool has its own 256-socket/64-per-port limit. Pending first-grant
requests count toward the shared exchange budget. They wait for that authenticated
grant or revocation rather than racing startup. A reused native connection cannot
switch runtime owners. Loopback aliases retain the browser's ordinary cookie
rules; the dedicated root addresses provide the separate cookie hosts.
