## Waffle preparation

Class **Host feature**. These are original bun-wasm adapters, not copied Bun, Node or
WebKit implementations. Waffle is the source-first browser runtime package at
`https://github.com/ShaulLavo/waffle`, consumed by bun-wasm through the exact Git revision
recorded in `web/package.json` and `web/bun.lock`. Its `index.ts` / `runtime.ts` composition owns
the page filesystem, registration, shared process identities and lazy supervision. A stable
global symbol guards one live owner; consumers borrow capabilities rather than receiving teardown
ownership.

Waffle's page filesystem and terminal adapters live in `waffle/browser/`. Their consumer-facing
configuration injects worker URLs and storage settings, retains Bun's workspace namespace in the
web wrapper, and removes outward runtime imports. Terminal destinations remain callback codecs,
not interactive terminal discipline. Generic tests live with the framing and terminal code;
Bun-specific process assertions stay in web tests.

Waffle's ring, protocol and HTTP/1 framing live in `waffle/browser/net/`. Generic `helper.ts`
requires an injected fetch function instead of importing Bun's installation cache. Generic
`host.ts` owns handles, rings, connection state and ordinary bytes; `web/src/net/host.ts` retains
guest-memory pointers, native function names and numeric slot bindings. `web/src/net/helper.ts`
retains only Bun's installed-fetch policy.

Waffle's preview protocol, request/socket routing and configurable service-worker handler live
in `waffle/browser/`. Bun's `web/src/{preview,sw}.ts` keep registration defaults, fixed module-cache
scope and guest websocket injection. These are original host adapters, not an upstream
service-worker implementation.

Waffle's generic worker bootstrap/protocol and process admission, descriptor transport,
finalization and supervision live in `waffle/proc/` and `waffle/browser/`; injected executors
keep only Bun engine, networking-slot and cache policy in `web/src/{bun-executor,bun-launcher}.ts`.
The guest imports `runtime_proc` directly; browser Bun processes use Waffle's process-owned
descriptors, pipes and typed outcomes rather than a separate `SubprocessHost` transport.
`web/src/subprocess-broker.ts` registers Bun executables and roots each run in that shared service.
Existing pipe provenance and interruption adapters remain classified in their sections below.

Waffle's `build.ts`, explicit conditional exports, trusted-Git install check and installed
package/source-asset/provenance tooling are original build/test adapters. They emit ignored
per-module JavaScript for Node without bundling independent state copies, preserve source-first
browser/Bun use and keep the 7 KiB core gate. No upstream implementation is copied by these
packaging changes.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Waffle browser services](#waffle-preparation) | Host feature | The Waffle package owns the browser runtime, worker/executor, filesystem, terminal, network and preview adapters separately from Bun policy. |

[Ledger scope and pinned revisions](scope.md).
