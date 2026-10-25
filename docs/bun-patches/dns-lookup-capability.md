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
after a new guest build. `scripts/dns-lookup.test.ts` also runs a prepared Waffle
export control under native Bun with a real Worker; plain Node is not used as the full
runtime host.

| Paths | Class | Provenance |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/dns.ts` plus minimal registration in `builtins.js` and `bun.js` | Host feature | Original Bun/Node public facade and Waffle adapter; no copied resolver implementation. |
| `web/src/net/lookup.ts`, `web/src/{bun-executor,bun-launcher,runner}.ts`, minimal `engine-host.js` registration | Host feature | Original browser worker bridge over Waffle `runtime.network().lookup`; TCP transport unchanged. |
| `tests/fixtures/dns-lookup/`, `scripts/dns-lookup.test.ts`, `web/tests/dns-lookup-bridge.test.ts`, `web/tests/dns-lookup-lifecycle.test.ts` | Host feature | Blocking facade, prepared-export, bridge, real engine lifetime and structured-error controls. |
