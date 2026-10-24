## Node default listener bind

The unspecified-host argument in `crates/bunwasm-runtime/src/js/node_net.js`
and `bind_addrs` / `bind_listener` in `crates/bunwasm-host/src/net/tcp.rs` are
original **Host feature** adapters. Bun `src/js/node/net.ts` and
`packages/bun-usockets/src/bsd.c` at
`9510e74152073d850a18758ca41114d8f214ffa6` are behavior references, not copied
implementations. The native host uses socket2 0.6 through its existing locked
package. It requests IPv6 any with `IPV6_V6ONLY` disabled, then tries IPv4 any
when that listener cannot be created. Explicit bind addresses retain their
existing path. No host ABI, browser endpoint metadata or Waffle pin changes.

This integrates only the remaining bind work from PR116. The landed Server
constructor helper and constructor-only controls stay unchanged. Socket
watermark, onread and resolver changes belong to separate work. The one-line
change remains in the existing JavaScript factory because the transport adapter
has not been converted to TypeScript; all new host-side script checks are
TypeScript.

`scripts/node-net-default-bind.test.ts` reaches the real Server argument handling
and stops at an injected bind failure. It checks only the argument passed to the
bind boundary, not an actual listener. All transport, waiter and close operations
fail if touched. The native Rust IPv4/fallback tests, the two guest fixtures and
the retained synthetic-pipe listener tests are controls for later acceptance.
Source-only checks do not establish their runtime behavior. The fallback control
denies IPv6 only in its disposable child and does not change host sysctls.

The retained pipe fixture now supplies the current Server helper's stream-default
getter and Abort globals. The guest fixture types narrow listener addresses and
explicitly describe inherited Server receivers without changing their assertions.
These are original test adapters, not upstream ports.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Default listen argument and native bind](#node-default-listener-bind) | Host feature | Original IPv6-any dual-stack listener and IPv4 fallback over the existing host ABI. |
| [Listener controls](#node-default-listener-bind) | Host feature | Original source-only argument check and retained native, guest and synthetic-pipe controls. |

[Ledger scope and pinned revisions](scope.md).
