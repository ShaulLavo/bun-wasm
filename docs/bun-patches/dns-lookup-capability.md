# DNS lookup capability boundary

Class **Host feature**, original bun-wasm adapter over Waffle's delivered runtime-owned
lookup capability. The public facade is original glue; it copies no Bun resolver
implementation and does not add an OS resolver, socket probe, Wasmtime import or
consumer-local address table.

The public contract is guided by Bun's `src/js/node/dns.ts` and
`src/js/node/dns.promises.ts` at upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6`. `crates/bunwasm-runtime/src/js/dns.ts`
owns the shared `node:dns`, `node:dns/promises` and `dns.promises` facade: overload
validation including the allowed hint mask, IP-literal fast paths, callbacks with the
empty-host null sentinel, promises, `all`, ordering and default
order state and the Bun-facing adapter. Minimal registration in
`crates/bunwasm-runtime/src/js/builtins.js` and `bun.js` maps Bun's resolver flags to
Waffle's `hints` option.

The backing capability is the prepared Waffle package at the pinned revision
`c1cb67c300439af24335d0b2ec481bfb52f79a01`, specifically
`browser/net/runtime.ts` and `browser/net/address.ts`. After `await runtime.network()`,
`network.lookup(name, { family, hints })` is synchronous, side-effect free and returns
fresh ordered records. Waffle owns virtual localhost policy and structured
`ENOTSUP`/`ENOTFOUND` lookup errors; it does not perform OS DNS, fetch, sockets or
process activation.

The browser runner bridges that capability through `web/src/net/lookup.ts` using a
root `MessageChannel` or per-launch `BroadcastChannel`. Minimal registration in
`web/src/engine-host.js` wraps lookup with the TypeScript `trackLookup` helper, using
the existing engine pending-work accounting and completion wake for success and
rejection. No polling timer or deadline is added. The existing TCP ring and
`node:process` descriptor ownership remain unchanged. The Rust native launcher has no
resolver slot, so the compiled blocking fixture covers the Bun-owned literal/overload
facade; hostname-backed Vitest/SolidStart startup remains a browser-runtime acceptance
after a new guest build. `web/tests/dns-lookup-bridge.test.ts` also runs a prepared
Waffle export control under native Bun with a real Worker, resolved from the Web
installation. The Web host gate prepares that package; the Rust source precheck
installs root tools with `--ignore-scripts` and runs only the facade controls in
`scripts/dns-lookup.test.ts`. Child stderr is asserted before the exit code so
preparation failures retain their cause. Plain Node is not used as the full runtime
host. The module-preparation benchmark rewrites the helper import to its
real file URL, and the isolated Node host fixture copies `net/lookup.ts` with its
other host assets. Its Waffle import is type-only and erased by Node. These controls
verify host module linking without claiming native hostname resolution.

| Paths | Class | Provenance |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/dns.ts` plus minimal registration in `builtins.js` and `bun.js` | Host feature | Original Bun/Node public facade and Waffle adapter; no copied resolver implementation. |
| `web/src/net/lookup.ts`, `web/src/{bun-executor,bun-launcher,runner}.ts`, minimal `engine-host.js` registration | Host feature | Original browser worker bridge over Waffle `runtime.network().lookup`; TCP transport unchanged. |
| `tests/fixtures/dns-lookup/`, `scripts/dns-lookup.test.ts`, `web/tests/dns-lookup-bridge.test.ts`, `web/tests/dns-lookup-lifecycle.test.ts`, `web/tests/core-node.test.ts`, `scripts/bench-module-preparation.ts` | Host feature | Blocking facade, prepared-export, bridge, real engine lifetime and structured-error controls. |

## Native operation provenance

The native hostname operation is an original bun-wasm host adapter, not copied Bun
resolver code. `crates/bunwasm-host/src/net/resolver.rs` owns a detached worker
around the platform `libc::getaddrinfo` call. It copies the length-delimited
hostname before spawning, maps the Bun/Node family and resolver-hint bits to
platform `addrinfo` fields, preserves resolver order, frees the returned list
with an RAII guard, and publishes one owned JSON result or one structured error.
The worker never retains a guest pointer, Wasm store, engine root or transport
handle. Closing a lookup marks it cancelled without joining the worker; a late
result is discarded.

`crates/bunwasm-host/src/net/{mod,error,tests}.rs` and
`crates/bunwasm-host/src/slots.rs` own the handle lifetime, ABI dispatch,
repeatable sized reads, poll wake, close/error behavior and focused native
controls. `crates/bunwasm-runtime/src/{host.rs,natives.rs}` adds only the
lockstep v2/16 data slots. `crates/bunwasm-runtime/src/js/host_lookup.ts`
converts those data operations into the existing referenced I/O waiter and
Promise settlement path; it does not add an engine Promise API or call a
blocked-Wasm Promise/message bridge. The adapter validates the complete
capability set, closes exactly once, preserves structured resolver fields and
leaves an existing Promise provider authoritative.

The browser raw lookup slots remain absent because this unit does not add a
Waffle transport/ring operation or claim compiled-browser DNS. The existing
browser-engine Promise provider and its startup, completion, pending-work and
cleanup ownership remain unchanged. `web/src/net/host.ts` derives capability
flags from implemented slot functions so appended names cannot advertise an
unavailable browser operation; `web/src/net/trampoline.ts` still carries the
lockstep metadata and arities for hosts that do implement the slots.
