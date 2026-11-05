## TCP and IP helpers

The empty-EOF handling in `node_net.js` is an original **Host
feature** adapter. An accepted socket with no buffered bytes must process its
readable EOF before its writable side has finished. Waiting for both sides
creates a cycle with Duplex's automatic write-side completion. The adapter now
calls its existing zero-byte read after empty EOF. Buffered data is preserved.
`net-tcp-empty-fin` forces server acceptance before the client ends, then checks
readable end, socket close and server close. Native Bun 1.4.2 and Node 26.7.0
supply the controls;
unchanged main and the response-streaming guest both fail before the correction.

The IP regular expressions in `crates/bunwasm-runtime/src/js/net_address.ts` come
from Bun `src/js/internal/net/isIP.ts` at
`4ceda2c2868d3a7703c7737ddd9de7244ec384df`. The adaptation keeps TypeScript
annotations in local source and replaces the module export wrapper with a runtime
factory. The runtime stripper erases those annotations during embedding. The
predicates themselves are unchanged.

The other address helpers, `node_net.js`, `bun_tcp.ts`, and the changes to
`net.js`, the Rust host and the browser hosts are original adapters. They share
one byte transport with fetch, Bun.serve, and WebSockets. The added host slots
provide write-side shutdown and the local endpoint. HTTP upgrade listeners get
a real Socket with the bytes received after the request header. The original
adapters also own pipe backpressure across multiple destinations, cancellation of queued writes, exact-size
reads, timeout listener cancellation, and bounded HTTP upgrade handshakes.
The native network allocator also rejects handle exhaustion before starting an
operation or consuming an accepted socket, preserving the separate process/pipe
handle range and returning EAGAIN without partial resource creation.
No additional upstream implementation was copied for these corrections.

`Bun.listen` (`bun_tcp.ts`) binds its accept waiter to the async-context frame
current at `listen`, through `net_listener`'s `inContext`, as native Bun does:
`enterWith` before it, a scoped `run` around it, and not a frame entered after
it. The host enters every I/O turn in the root frame
([0008](0008-await-context-hooks.md)), so without this an accepted socket's
`open`, `data` and `close` callbacks saw none. Accepted sockets start reading in
that frame and hold it until they close; `stop` drops the accept waiter, so a
stopped listener that stays reachable no longer holds it. `Bun.connect` already
kept its connect-time frame through `node:net`. `web/tests/bun-listen-context.test.ts`
compares the maintained adapter, on the hook path and with a native continuation
provider, with native Bun over loopback sockets, and checks the caller's frame
around a synchronous pump and each stop path's retirement.

`Bun.serve` started inside an explicit frame (`enterWith` or `run`) binds its accept waiter to that frame
through the same `inContext`, so its connections start reading there and route handlers run in it, as native
Bun reports. A server started outside any frame is unchanged: each request starts in the turn's frame, which
is root on the hook path. Native Bun instead reports the frame current at its first request, so this is a
known difference. `stop` drops the accept waiter. Direct `server.fetch` stays a caller entry and `reload`
keeps the registration frame; native Bun runs both in the original or reloaded registration frame. Those
differences predate the root entry and are not changed here. A fetch handler after the server's internal
await relies on prepared source for its frame on the hook path.

Bun's `src/js/node/net.ts` depends on native Bun sockets, private stream modules,
and runtime intrinsics. Its BlockList and SocketAddress use native bindings.
These adapters implement the public contracts over our host handles while those
bindings remain unavailable. This is not a switch to Bun's full net module.
The upstream comparisons are recorded in [TCP support](../tcp.md).


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/net_address.ts`, IP predicates](#tcp-and-ip-helpers) | Port | Adapt Bun's engine independent IPv4 and IPv6 predicates. |
| [TCP adapters and HTTP upgrade sockets](#tcp-and-ip-helpers) | Host feature | Original adapters add duplex sockets, empty-EOF completion, write-side shutdown and bounded native handle allocation over the existing host ABI. `Bun.listen` accepts in its listen-time async-context frame, and an explicitly framed `Bun.serve` in its serve-time frame. |

[Ledger scope and pinned revisions](scope.md).
