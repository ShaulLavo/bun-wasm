## Typed WebSocket byte-stream adapter

| Classification | Upstream | Local source | Reason |
| --- | --- | --- | --- |
| Host feature, original adapter | No copied implementation. RFC 6455 sections 4 through 7 and the existing Bun WebSocket API | `crates/bunwasm-runtime/src/js/websocket.ts` | Type the existing byte-stream adapter and its preview loader |

The original source is `websocket.js` at
`ac43127c85addabed7e0c2a4883247ae074e858c`. The separately generated
`ws_builtin.js` remains the unchanged websockets/ws v8.18.3 implementation.
No native, HTTP, TLS or transport implementation changes here.

Erased declarations describe frames, connection callbacks, peer state, Blob and
byte queues, handler arguments and the two-argument hostConnect native. The
preview bundler resolves a private factory import to the same TypeScript source.
Existing web tests load the canonical Node-stripped factory without checking in
compiled JavaScript.

Handler invocation now uses a discriminated tuple and exhaustive dispatch. The
compiler checks each handler's arguments without an assertion. The provider is
still called inside the same try block, its named property is read once and the
handler keeps that provider object as its receiver. The already Error-typed peer
error callback no longer asserts its message shape.

`scripts/runtime-websocket.test.ts` pins the complete original runtime syntax
after reversing the checked dispatcher and the exact state checks below. Pure synthetic controls compare
provider/getter reads, callback receivers, arguments, synchronous failures and
rejected promises. `scripts/runtime-types.test.ts` checks valid and invalid
native, connection, queue and correlated invocation types. Existing native
fixtures remain registered but require separate final-source qualification.

Nullable connection, handshake and peer reads, and queue extraction now use an
explicit null/undefined check at each original consumption point. The check
throws a TypeError for missing state instead of silently dropping work. It does
not prove the shape of values from untyped callers. Mutable fields are still read
inside deferred callbacks and after Blob conversion, not captured earlier. Queue
bookkeeping uses a synchronous helper without introducing another await. The
absent close timer is passed to clearTimeout as undefined rather than null.
Tests pin these exact changes and compare queued sends against the old source.

Three dynamic-boundary assertion exceptions remain intentionally visible. A caught
code keeps its raw value so each comparison and bitwise operation performs its
own JavaScript coercion, and the same value reaches the close callback. The
second optional error-handler lookup remains an ordinary member call. It can
throw or disappear after the first lookup, and its provider is the receiver.
Validating or caching either value would change these observable behaviors.
The caught message assertion permits property access with the original receiver,
including primitive getters and nullish access failures. Its value is `unknown`,
not an assumed string. None of these assertions proves an arbitrary caught value
has the declared shape. Their exact expressions are inventoried in the test.
Numeric public callback declarations are unchanged.

The owner selected real Bun behavior on 2026-10-26 and allowed these narrowly
tested exceptions. Native Bun 1.4.4, revision `38afee6c8`, is the message-constructor
oracle. Its executable SHA256 is
`10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235`.
`ErrorEvent` converts a defined message to a string, defaults undefined to an
empty string, preserves the original error value, and throws on a Symbol.
The adapter now reads the message once after closing state and destroying the
connection. An init accessor defers conversion until the constructor reads the
message, after the global constructor lookup. Template interpolation preserves the
native string hint and Symbol failure; `String(message)` would accept Symbols.
This corrects the local web shim's raw-message forwarding without changing the
shared shim. A coercion failure prevents both error and close events.

CI-discovered pure controls compare against the installed native Bun
`ErrorEvent` constructor. They also run the canonical stripped adapter in Bun
with synthetic byte connections to pin both handler lookups, the second receiver,
getter failures, one code lookup, four independently varying coercions, BigInt
bitwise failures, raw close-code identity, and falsy getter/coercion throws.
The latter are adapter JavaScript controls, not claims that Bun's native socket
API exposes the same internal hooks. The syntax inverse explicitly reverses the
message conversion as well as the earlier dispatcher and state checks; it still
pins the original source hash and rejects mutations to those changes.

Missing internal state fails at the explicit check, so invalid partial handshakes
can fail earlier and null-dereference error messages change. This is a deliberate
state validation change, not an annotation-only or whole-program parity claim.
No final guest/native-socket/browser acceptance is claimed. Historical guests are
not build evidence for this source. OS transport stays in Waffle; this change
only adapts the JavaScript WebSocket API to the existing byte connection.
