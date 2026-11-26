# Preview WebSocket request headers

Classification: original local adapter. No upstream implementation is copied.

`web/src/preview-websocket-client.ts` adapts the shared runtime WebSocket client
to the preview service worker's MessagePort transport. The constructor accepts
the browser-visible URL. Its handshake keeps that URL's Host and uses the
preview document's Origin, including its scheme and outer port. The mounted
preview prefix is removed from the request path. `connect()` still routes the
stream using the injected guest port, independently of the HTTP authority.
The adapter captures that authority before converting to the plain transport
scheme, which can otherwise discard an explicit secure port 80. Synchronous
constructor scope binds each stream to its own authority and restores the prior
scope even when protocol access constructs another socket or throws.
Host and Origin are inserted with literal replacement callbacks, so URL text
cannot be interpreted as replacement-string syntax.

Previously both headers described the virtual localhost endpoint. Applications
therefore received different headers from those a browser would send. Keeping
the visible authority also lets Bun's existing HMR origin check compare the
document hostname with the requested hostname. The shared client, service-worker
authorization, raw TCP requests and HMR foreign-Origin policy are unchanged.

On a preview origin ([Preview origins](../preview-origins.md)) the same adapter is
bundled into the injected page script. There the app owns `/`, so no prefix is
removed, only same-origin URLs are tunneled, and the upgrade leaves as structured
fields (URL, method, header pairs) without Host, Origin or Cookie: the IDE page
supplies those and Waffle writes the handshake. Later bytes are unchanged.
The other end of that stream is the IDE tab itself, so an open socket also pings
it every 15 seconds and fails after two unanswered pings, or at once where the
browser reports the port closed. A mounted preview starts no such timer.

`web/tests/preview-websocket-client.test.ts` checks the emitted upgrade bytes,
one Host and Origin, requested paths, negotiated protocol and separate tunnel
routing for custom names, loopback addresses and different outer/guest ports.
A foreign document Origin stays foreign when targeting the guest loopback,
so the adapter does not turn it into an allowed localhost Origin.
It stays owned by the existing Web unit-test glob. The original
`web/tests/browser-net.mjs` checks the complete preview path and HMR behavior.
