# Combined socket and process idle wait

## Original adapters

`crates/bunwasm-runtime/src/{host.rs,natives.rs,js/net.js,js/worker_protocol.d.ts}`
and `web/src/net/{host,trampoline,mixed-wait}.ts` implement Bun's optional
`poll_io` slot. These are original host adapters, not copied Bun, Node, WebKit
or Waffle implementations. `web/src/bun-executor.ts` arms the existing Waffle
notification scope with network and process sources for networked in-guest
engines. `crates/bunwasm-host/src/slots.rs` accepts the ABI v2/count19 table and
deliberately leaves the optional slot zero. The headless web shim also omits it.

The mixed selector collects actual referenced process subscriptions alongside
network waiters. Its native owns separate input and initialized output buffers,
rejects partial records and throws numeric errors other than unsupported through
the existing native error mechanism. Bun's memory adapter uses the process ABI's
validated nonblocking poll and expected error classes before registering coverage.
The shared loop checks one absolute deadline independently of atomic wake reasons,
keeps process readiness non-consuming and consumes network news only once.
The affected network-only slot uses the same loop with empty subscriptions.
Normal guest pumping still occurs only after the host call returns.

The consumed dependency is Waffle 0.0.121, source
`6515a313bdc5b6b56491eab6210a3a58b9232224`. Its existing
`browser/notification-wait.ts`, `browser/net/host.ts` and `proc/abi.ts` interfaces
are used without copying or modifying them. No Waffle contract, timer, buffer
policy or Browser-engine pumping changes. Eager process arming costs one extra
waiter Worker per affected process and wakes peers under unrelated root traffic.

Tests execute the current selector and actual slot adapters through both browser
transports with real process, pipe, filesystem and notification Workers. Additional
boundary and deadline tests cover malformed spans, growth, restoration,
cancellation and unrelated traffic. Feature manifests own actual guest completion
and a matched Chrome resource check. Component results do not measure Safari
guest wait lateness or count as framework acceptance.

## Classification

| Source | Class | Change |
| --- | --- | --- |
| Original combined I/O adapters | Host feature | Optional mixed readiness slot and deadline-safe Bun wait loop over existing Waffle interfaces. |

[Ledger scope and pinned revisions](scope.md).
