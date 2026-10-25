# Product DNS promise lookup

Status: Approved, blocked on Waffle lookup capability. October 25, 2026.

## Observed failure

Vitest 3.2.4 with Vite 7.1.12 fails before running tests in all three measured
commands. Vite's `dist/node/chunks/config.js:2517` calls:

```ts
await Promise.all([
  dns.promises.lookup("localhost"),
  dns.promises.lookup("localhost", { verbatim: true }),
]);
```

Evidence is `/work/reports/bun-wasm/product-matrix-20261025/baseline-servers-tools/report.md`
and `vitest-browser-playground.log` in that directory. The baseline's working
HTTP servers do not prove this separate lookup API exists.

At Bun source base `c16ff39435cc33465b999ea06c1ee9d20b952354`, both DNS
factories in `crates/bunwasm-runtime/src/js/builtins.js:710-711` install throwing
stubs. `node:dns.promises` and `node:dns/promises` share one object through the
builtin cache. Neither callback nor promise lookup reaches a native function.
`Bun.dns.lookup` is also unsupported in `src/js/bun.js:540` of that crate.
This is not an undefined identifier or module-loading failure. It is an explicit
`Error` with code `ERR_NOT_SUPPORTED_IN_WASM`, thrown before a promise exists.

PR #120, inspected at head `3ccc32f7e5535b86ecb82175fca802cbe32dd170`, only
changes hostname validation in `node_net.js` and `bun_tcp.js`. Its DNS-named
fixture checks connection/listen errors. It neither implements nor changes the
DNS builtin factories. There is no duplicate lookup implementation to adopt.

## Needs from other tracks

Waffle must expose side-effect-free address lookup, including its virtual
browser network's localhost mapping. The concrete consumer needs are:

```ts
// Requested capability, not an existing exported Waffle method.
lookup("localhost", { family: 0, hints: 0 });
// Promise<Array<{ address: string; family: 4 | 6 }>>
```

The result must contain the namespace's addresses in resolver order, without
creating a listener, connection, fetch, process or other user-visible resource.
The eventual Bun adapter also needs families 4 and 6 and lookup hints. Lookup
failure must preserve a structured code and `syscall: "getaddrinfo"`, plus the
requested hostname. An unsupported host capability must stay distinguishable
from `ENOTFOUND`. Waffle owns whether non-local names are available, and it owns
consistent virtual loopback addresses across processes. No browser OS resolver
or raw internet TCP is required just to satisfy this localhost consumer.

Bun will consume that capability from the shared runtime factory used by
`node:dns.lookup`, `node:dns.promises.lookup` and `node:dns/promises.lookup`.
The two Vite calls above need the same address set. Bun applies default versus
verbatim ordering, `all` result shape, callback delivery and Node validation.
The Waffle track owns its transport, cancellation and resource cleanup. Agree
its exported call before adding Bun native names or ABI slots.

Evidence that the current bridge cannot supply this operation:

- Bun's `web/src/net/host.ts` exposes fetch, TCP handles and endpoint inspection,
  but no lookup. `crates/bunwasm-runtime/src/natives.rs:1313-1351` matches it.
- `docs/host-abi.md` lists 14 slots, none for resolving an address without a
  socket. `peer_addr` needs an existing connection; it is not lookup.
- Pinned Waffle `b20fad173ebaa225cb87c51776f35edaaafd4a40` has no lookup method,
  request or event in `browser/net/{host,protocol}.ts`. Its loopback table is
  private to connect. The locally available Waffle `origin/main` snapshot
  `d9973ca6b892ecf4b8a210be5328eb2645207d0d` also has no lookup entry there.

Do not use `hostConnect`, `hostListen`, HTTP fetch, public DNS-over-HTTPS, host
`/etc/hosts`, or a Bun-local hardcoded localhost table to imitate the capability.
Promise-wrapping the unsupported stub only changes how Vite fails.

## Cheap reproduction and reference observations

The actual factory can be reproduced without a guest, build, browser or socket:

```sh
source env.sh
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const registry = {};
const source = readFileSync("crates/bunwasm-runtime/src/js/builtins.js", "utf8");
runInNewContext(source)({ native: {}, builtinFactories: registry });
await registry["node:dns/promises"]().lookup("localhost");
JS
```

The queued source probe at
`/work/reports/bun-wasm/product-matrix-20261025/dns-promises/probe.ts` additionally
loads both real factories through a cache and denies every native access. Under
Node 26.12.1 and Bun 1.4.4 it records nine synchronous unsupported errors and zero
native accesses, then exits 1 on the unresolved Vite requirement. It is a failing
reproducer, not a passing regression or product acceptance. The host references
use only IP literals and invalid arguments, not native hostname resolution.

Both references resolve `lookup("127.0.0.1", 4)` to one IPv4 object and
`lookup("::1", { family: 6, all: true })` to a one-element IPv6 array. They throw
`TypeError/ERR_INVALID_ARG_TYPE` synchronously for an object hostname or
non-boolean `all`/`verbatim`, and `TypeError/ERR_INVALID_ARG_VALUE` for family 5.
The current guest factory instead throws its unsupported error for all of them.

## Resume after the capability lands

Prefer Bun's existing callback/promise policy in `src/js/node/dns.ts` and
`src/js/node/dns.promises.ts`, pinned upstream
`9510e74152073d850a18758ca41114d8f214ffa6`. The promise module aliases
`node:dns.promises`; the main module uses `Bun.dns` and native resolver hooks,
so selecting it without that backing does not fix startup.

Implement one shared lookup policy, preserve module identity, cover overloads,
invalid input timing, IP fast paths, ordering, `all`, structured host errors and
callback delivery. Register its source regressions once under a feature-owned
`checks/runtime-dns-lookup.json` with `localRuntime: true`, and record provenance.
Do not freeze the current unsupported error as the expected successful contract.
This blocked handoff changes no runtime behavior or check selection.

Parent owns independent review, final natural CI, serial merge and later actual
Vitest/browser acceptance. No guest/native/browser/app build or campaign, CI
operation, version bump, dependency change or check relaxation ran in this lane.
