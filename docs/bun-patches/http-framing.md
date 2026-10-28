## HTTP framing

Class **Host feature**, **original adapters** in `src/js/net.js`,
`src/js/http_common.ts`, `src/js/http_body.ts`, `src/js/http_agent.ts`,
`src/js/http_response.ts`, `src/js/http_server_response.ts`, `src/js/fetch_body.ts`,
`src/js/body_streams.ts`,
byte-stream metadata in `src/js/web.js`, socket-close
completion in `src/js/node_net.js`, and the `node:http` registry
in `src/js/builtins.js`. No upstream implementation is copied or patched.
Bun's `src/js/node/http.ts` depends on native HTTP bindings, so this change keeps
the existing portable adapter over the socket ABI.

The Node v26.7.0 control and Bun's Node test files at
`9510e74152073d850a18758ca41114d8f214ffa6` supply behavioral references.
Header commitment is distinct from flushing bytes. Response framing preserves
explicit length and transfer encoding, streams chunked bodies, omits bodies
for HEAD and bodyless status codes, and writes trailers. `ServerResponse` also
exposes Node's `_implicitHeader()` and serialized `_header` state so response
middleware can commit headers through `writeHead()` before writing or ending.
`scripts/net-http-flow.test.ts` exercises that compression-middleware contract
against the real response factory. HTTP clients use the
same socket transport for ordinary and upgraded responses to preserve raw
header names and trailers. A typed incremental body decoder handles fixed,
chunked, and EOF framing. Header, method, path and status validation occurs
before protocol bytes are written. A 100 Continue response can precede the
request body. Server upgrades expose the parsed request body and its EOF before
handing later bytes to the upgraded socket.

The HTTP client checks header coercion and path/method/header validation order
against native Node. Response parsing rejects duplicate lengths, invalid lengths
and transfer-encoding/length conflicts in wire order. Only a final `chunked`
transfer coding selects chunk decoding. Lengths must fit a safe JavaScript integer.
The Agent pool retains framed keep-alive responses after consumption, removes
request parser listeners, unreferences idle sockets, guards unsolicited idle data,
and closes sockets on timeout, remote close or Agent destruction. Requests without
an Agent advertise close. GET, HEAD, DELETE, OPTIONS, TRACE and CONNECT do not get
automatic body framing, including when headers flush before `end()`.

The response-remainder handling uses Node's `test/parallel/test-http-extra-response.js` at the same
upstream revision as a behavioral reference. The decoder returns consumed output
and unconsumed remainder separately. A remainder retires the connection before
pool release, preserves the first response body/end, and reports invalid prefixes
with `HPE_INVALID_CONSTANT`. Bytes after a nonpersistent response produce
`HPE_CLOSED_CONNECTION`. A completed response enters a draining state so incoming
data cannot disappear between parser removal and stream consumption. Empty or
whitespace-only transfer-encoding fields produce `HPE_INVALID_TRANSFER_ENCODING`
before informational, upgrade or bodyless-response dispatch.

The Streams main integration keeps HTTP transport work in Writable lifecycle
hooks. The original TCP adapter defers socket-destroy completion to the check
phase so the completed request stream closes before its socket, as in Node.
`net-http-close-order` compares this order unchanged on Node and all engines.

The server streaming code is original typed adapters for Bun response
streaming and fetch-body abort cleanup. Bun Response streams send headers and
body chunks without waiting for EOF. Each socket write finishes before another
chunk is read. Fixed byte bodies retain their existing Content-Length path.
These adapters use Bun's unchanged tests at
`5e0baa66516f3af00b008cdf1521c681317741e8` as behavioral references.
The response adapters use native Bun 1.4.2 as a behavioral reference. Unknown-
length Bun response streams ignore a supplied Content-Length and use chunked
framing. The response reader owns its EOF and close callbacks, which cancel it
with native Bun's undefined disconnect reason and leave externally locked
streams alone. The connection records peer EOF before notifying its reader.
When an awaited handler returns after EOF or close, the response writer destroys
the transport and starts cancellation of the unused source before acquiring a
reader or writing headers. It does not await asynchronous producer cleanup,
which may itself wait for the peer to observe EOF. Cancellation still runs once
with an undefined reason. The existing ownership guard leaves externally locked
streams alone. The deferred-cleanup regression uses native Bun 1.4.2 as its
behavioral reference. Node sockets retain
their separate half-close policy. Fetch-body waiter steps and rejection handling
stay outside the promise executor, within three nesting levels. Fetch body and
header waits preserve the exact AbortSignal reason, including null and other
falsy values. These are original adapter corrections; no native Bun or Node
source is copied. The shared body-stream helper owns clone validation and tee
metadata for Request and Response. Request construction also transfers an inherited
body through a reader-backed stream instead of copying cached bytes or teeing it.
The source stays locked and used, while cancellation and producer errors reach the
new owner. Host engines validate the existing stream with the captured native
Request constructor before acquiring its reader. This rejects native disturbed
streams without adding a body-use observer or modifying the separate observer
adapter. Explicit replacement bodies leave the source alone. Request redirect
mode is inherited when only headers change. These original corrections use Node
26.12.1 and Bun 1.4.4 as behavioral controls, not copied implementations. Node is
the reference for post-transfer disturbance: Bun 1.4.4 leaves the source's
`bodyUsed` false. `tests/fixtures/runtime-request-copy` checks the constructor and
actual fetch path; `scripts/request-copy.test.ts` executes the Web factory and
unchanged fetch adapter with shipped and native streams. The
strictly typed stream generator produces byte-identical output for its pinned
input.
Node request dispatch retains its existing complete-upload behavior.

Node HTTP responses preserve stream demand across the adapter boundaries. Raw responses pause their socket when `IncomingMessage.push()` is full and retain decoded output until `_read()` resumes it. Fetch-backed HTTPS responses use one body reader, stop after a full push, and cancel that reader on request or response destruction instead of awaiting `arrayBuffer()`. Server writes report backpressure, complete callbacks after their framed bytes are accepted, emit one drain after queued writes settle, and propagate cancellation to write and end callbacks once. `ClientRequest.setTimeout()` updates and disables inactivity timers before or after connection establishment; raw requests use the socket timer, while fetch-backed requests reset their own timer on response activity and clear it on completion or destruction. Raw socket attachment clears the provisional request timer and installs one timeout forwarder per exchange. Duration updates do not add forwarders; terminal cleanup removes the forwarder even after disabling the timer. These are original adapter changes with native Bun 1.4.4 and Node 26.12.1 behavioral controls, not copied upstream implementations.

HTTPS requests continue to use the host's TLS fetch transport. The raw socket
ABI has no TLS capability, so HTTPS upgrades without a caller-supplied connection
fail with `ERR_TLS_NOT_SUPPORTED` instead of opening a plaintext connection.
The caller-supplied connection path retains caller ownership of TLS setup.

[The HTTP compatibility report](../http-compatibility.md) records the controls and measurements.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Server response destruction](#server-response-destruction) | Host feature | Original typed response cancellation over the existing socket lifecycle. |
| Request body copying in `web.js` and `body_streams.ts` | Host feature | Original reader-backed ownership transfer and inherited redirect state. |
| [HTTP request and response framing](#http-framing) | Host feature | Original header state, validation, streaming bodies, response cancellation independent of transport disposal before and during writer ownership, Agent pool, client inactivity timer ownership and upgrade response adapters shared by all engines. |

[Ledger scope and pinned revisions](scope.md).


### Server response destruction

Class **Host feature**, **original adapter** in
`crates/bunwasm-runtime/src/js/http_server_response.ts`, with prototype wiring and
HTTP socket error forwarding in `src/js/net.js`. No Bun or Node implementation is
copied. Behavioral references are native Bun 1.4.4 and Node 26.12.1's `node:http`
`ServerResponse.destroy`, corresponding to Bun `src/js/node/http.ts` at the pinned
revision above and Node `lib/_http_outgoing.js` at tag `v26.12.1`.

`destroy(error?)` returns the response itself and marks it destroyed immediately.
It delegates cancellation to the existing Socket and Connection lifecycle, which
closes the host handle, removes I/O waiters and timers, and settles queued writes.
The first error reaches the socket and HTTP server's `clientError` event, not a
response `error` event. Socket close emits response close once. Destruction settles
the adapter's request completion without reusing the connection. End completion
already queued before cancellation cannot emit a successful finish afterward.
The existing end-completion method moved into the typed helper for this guard.
Late writes return false with `ERR_STREAM_DESTROYED` without committing headers;
accepted writes cannot emit drain after destruction.

`scripts/net-http-flow.test.ts` covers blocked write/end cancellation, exact error
and return identities, repeated destruction, falsy optional errors, queued end
completion, and the actual HTTP server connection cleanup. Node and Bun differ
when native writes have already completed: Bun can finish a small response
synchronously before a later destroy. The queued-cancellation guard follows Node;
it does not undo a finish already delivered. These source tests are not a rebuilt
guest or a Next.js application acceptance result.
