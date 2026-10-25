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

This remains a held source checkpoint, not an assertion-free conversion. Three
pre-existing assertions remain: caught error code and message reads, and a second
lookup of an optional error handler. Erasing their type syntax still fails strict
compilation. Their coercion, getter and arbitrary-thrown-value behavior needs a
separate correction or scope decision. No new error policy is assumed. Missing
internal state now fails at the explicit check, so invalid partial handshakes can
fail earlier and null-dereference error messages change. This is a deliberate
state validation change, not an annotation-only or whole-program parity claim.
No final guest/native/browser acceptance is claimed, and historical guests are
not build evidence for this checkpoint. OS transport stays in Waffle; this change
only adapts the JavaScript WebSocket API to the existing byte connection.
