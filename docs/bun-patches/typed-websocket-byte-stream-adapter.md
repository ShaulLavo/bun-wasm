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
after reversing only the checked dispatcher. Pure synthetic controls compare
provider/getter reads, callback receivers, arguments, synchronous failures and
rejected promises. `scripts/runtime-types.test.ts` checks valid and invalid
native, connection, queue and correlated invocation types. Existing native
fixtures remain registered but require separate final-source qualification.

This is a held source checkpoint, not an assertion-free conversion. Twelve
pre-existing assertions remain around caught property reads, nullable internal
state and queue extraction. They require a separate correction and review;
compiler success does not validate those asserted claims. No runtime acceptance
is claimed for this checkpoint, and historical guests are not its build evidence.
