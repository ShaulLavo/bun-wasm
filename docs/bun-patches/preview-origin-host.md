# Local preview origin host

Classification: original Bun consumer adapter. No upstream implementation copied
or adapted.

`web/preview-origin-host.ts` owns a bounded collection of local HTTP listeners.
Each listener belongs to one opaque runtime owner and virtual port. It forwards
the original root path to a server-owned endpoint. Its node:http listener exposes
the original WebSocket upgrade request, already-read head bytes and raw socket,
so the consumer can connect Waffle's raw relay without another WebSocket codec. Closing a binding aborts pending HTTP and
terminates sockets. Old origins cannot be assigned again during the host lifetime;
a late close cannot unregister a replacement binding.

Waffle PR160 owns the authenticated page relay and generic root URL policy. Its
published relay types must be connected before this adapter can carry browser
runtime traffic. The native fixture tests qualify only the listener boundary.
They do not establish React Router app acceptance or a working page relay.

`web/src/preview.ts` accepts the router's options unchanged. Explicit root mode
uses the host's transport and skips Bun's mounted preview worker registration.
The playground's separate module-worker scope remains independent.
