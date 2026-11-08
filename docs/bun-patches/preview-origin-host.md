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
loopback hostname and origin with its application at `/`. The maintained app harness selects
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

Cancelling registration retains the old route ID until its outstanding reservation,
binding factory or grant reply settles. Only that expected reply can retire the ID.
A replacement on the same port gets a new ID, and a late binding closes without
publishing. Active and closing registrations share a 128-entry limit. A closing
registration that does not settle within 30 seconds closes the owner connection.
Unknown IDs and mismatched replies still fail closed.

`web/preview-origin-host.ts` owns the native node:http listeners under Bun. It
preserves HTTP method, target, headers, bodies, status, cookies and cancellation.
It exposes the original upgrade request, already-read head bytes and raw socket
so Waffle receives the actual WebSocket handshake and duplex bytes.
`web/scripts/preview-exchanges.ts` holds the native HTTP stream and socket exchange
state, keeping their callbacks outside the owner session's request handlers.

The defaults bound the host to 128 lifetime origin allocations, 128 outstanding tickets or
connected owners, 16 ports per owner, 64 active exchanges across owners, 256 root
sockets across the host, 64 sockets per origin, 4 MiB request bodies/chunks and
8 MiB control frames/send queues. A root hostname is not shared with another owner or port, so cookies cannot cross
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
Native port conflicts fail without touching a pre-existing listener. Each shared
fixed-port listener also accepts exact hostname leases for currently allocated
roots, so a native client using its page hostname and another registered port
reaches that owner. A hostname lease requires the matching owner Origin. The
physical listener binds only to `127.0.0.1`, never to a randomized `127.x` address. Registration in either order adds the missing host/port pairs.
Closing a root releases its hostname leases and associated sockets; closing a
port releases that owner's leases for that port. A retired hostname gets HTTP 403
if a sibling keeps the shared listener alive. It cannot dispatch through that
sibling or another owner. Foreign owner Origins remain rejected before dispatch. No package
configuration, application URL rewriting, history patch or service-worker opener
is needed. This specifically covers generic extra server ports as well as the
primary port.

The harness's `preview-paths.ts` observer records only the actual first HTTP
request line sent into each virtual server connection. Original bytes, headers
and bodies are forwarded unchanged. Root-mode app results retain caller pathname
and those server request targets as independent path-agreement evidence.

The virtual-port pool retains its 512 host/port allocation bound, 256 sockets in
total and 64 sockets per physical listener. Each virtual port shares one literal
loopback listener. Repeated reservation of the same lease uses no extra slot. Pending first-grant
requests count toward the shared exchange budget. They wait for that authenticated
grant or revocation rather than racing startup. A reused native connection cannot
switch runtime owners. Loopback aliases retain the browser's ordinary cookie
rules; the dedicated root hostnames provide the separate cookie hosts.

Root-mode HMR evidence comes from actual native browser WebSocket frames. The
mounted-mode observer continues to handle the runtime polyfill's dispatched
messages. Native events bypass JavaScript dispatchEvent, so using only that hook
would falsely report missing updates. Native mode does not patch browser events,
constructors or URLs, and a real-browser regression rejects synthetic events as
native traffic. Persisted path observations omit query strings, and browser
error diagnostics redact token query values.

The app matrix stops its server through the maintained terminal focus and real
browser keyboard Ctrl-C helper. It waits for shell idle and command completion,
accepts normal handled exit or status 130, and retains the listener-removal checks.


## Portable loopback hostnames

Each root uses a fresh single-label `bw-<counter>-<UUID>.localhost` hostname and an
ephemeral TCP port. Its socket binds only to literal `127.0.0.1`. The host lifetime
counter prevents retired hostname reuse even if the OS reuses a TCP port. Exact
Host and URL-origin checks still reject alternate hostnames on a root listener.
No DNS server, interface alias, hosts-file edit or wildcard listener is provisioned.

[RFC 6761 section 6.3](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3)
reserves `localhost` and its children for loopback resolution. This adapter requires
the browser and local resolver to honor that rule. The single-label names also
keep distinct roots cross-site and reject a shared `Domain=localhost` cookie.
The executable browser control checks actual resolution, both cookie properties,
Fetch metadata and foreign-owner rejection without resolver overrides.

[WebKit bug 160504](https://bugs.webkit.org/show_bug.cgi?id=160504#c19) records
macOS 26 support, with implementation confirmed in OS frameworks below WebKit.
Older macOS support is not claimed. Linux Chromium, Firefox and WebKit controls
are not macOS Safari, iOS Simulator or physical iPhone acceptance evidence.
Native delivery checks must exercise their actual browser and resolver.

`scripts/preview-origins-browser.test.ts` belongs to the existing Web browser gate
through `checks/web-browser-preview-origins.json`. It defaults to the gate's
installed Chromium and WebKit. `BUN_WASM_PREVIEW_BROWSERS=chromium,firefox,webkit`
also runs Firefox when installed. The canonical-loopback-only regression runs in
`web/tests/preview-origin-host.test.ts`; exact hostname leases, connection identity,
the allocation bound and repeated cleanup run in `preview-port-sockets.test.ts`.
