# Raw TCP relay host integration

Classification: original consumer adapters.

`web/src/net/relay.ts` owns one relay capability per borrowed process Runtime.
The Bun launcher, manual runner, subprocess broker and network helper pass the
released networking owners and transferable bindings to their process workers.
They import the runtime and relay packages rather than copying their implementation.
Root, web and sandbox select runtime 0.0.109; root and web select relay 0.0.109.
Programs 0.0.15, manifest schema 2 and host interface 1 remain unchanged.

Relay revocation is recorded independently of client creation. Disposal during
the deferred import prevents later initialization. A stale connector rejects
before token acquisition. The source regressions in
`web/tests/network-consumer.test.ts` stop at a throwing token callback before I/O.
They preserve the existing helper, child-launch and installer-cache assertions.

Only the bounded host dependency is integrated here. The separate historical
C1 fixture runner is not included. Source tests do not establish guest admission,
raw TCP closure completion, PostgreSQL acceptance or a new producer delivery.
Forced process stop still needs a target or relay observation of that process's
connection closure, without closing a shared carrier used by other processes.
