# Shared nested Wasm, QuickJS and Browser host

Classification: Original host adapters. `web/src/nested/host.ts`, `wire.ts` and
`module-info.ts` are the Browser counterpart of the native service described in
[Shared nested Wasm, QuickJS and native host](shared-nested-native.md). No interpreter,
compiler algorithm or upstream runtime implementation is copied into these files. The guest,
wire contract and regionizer are unchanged.

A memory group member's worker loads the host on demand and supplies the shared-group-only
`runtime_nested.request` import. Regionized modules compile and run on the page's own
WebAssembly engine, in that worker, importing the group memory. This is the embedded engine
path. Browser engine guests keep their native WebAssembly route and never load this host.

The host uses only public surfaces of the pinned Waffle package: `createRuntime({ memoryGroups })`,
root adoption with `"group"`, `admitRootMemoryGroup`, `launchWorker({ memoryGroup })`, and the
worker executor's `namespaces` and `beforeBindings` hooks. A group core imports only the
`runtime_shm` functions it uses, so the host passes a small declaration module to the public
`wasi.imports` to resolve `shm_create`, `shm_detach`, `futex_wait32`, `futex_wait64` and
`futex_wake` from Waffle's documented ABI.

Requests and replies follow the frozen serde enums in `wasm/nested_wire.rs`. I64 and F64
payloads keep their decimal text, because JSON numbers would round them. The JS API does not
reflect function types, so `module-info.ts` reads them from the regionized bytes.

Each nested memory is one `shm_create` region of its whole declared maximum, charged by the
group owner. Handles carry a slot and generation, as on the native host. Growth zeroes the
newly visible pages before publishing the length and never moves storage. A failed defined
memory detaches its region. Waffle's owner reclaims published regions and holds after the
member's physical stop.

Nested waits and notifies, and QuickJS `Atomics`, use the same `runtime_shm` futex calls on the
same group address. A blocked member is cancelled by Waffle's hard stop. An exit or trap out of
a reentered core entry ends the member. A trap becomes status 134 with a bounded diagnostic at
the outermost request, because a stack overflow leaves no room deeper down. A trap confined to
nested Wasm stays a catchable `RuntimeError`, and a pending JS exception keeps its exact
engine-side value.

Differences from the native host:

- There is no Wasmtime Store, so the 40-instance ceiling and the admission closure that guards
  retained Store wrappers do not apply. Failed starts retain nothing here. The published
  instance limit is 4,096.
- Waffle limits one region to under 2 GiB, so a larger reservation reports a region admission error.
- The JS API reads one value per import module and name. Two imports with the same name and
  different function types are refused with a `LinkError`.
- f32 and f64 values cross JS numbers at this boundary, so NaN payload bits are not guaranteed.
- A group core spawned as a child starts its own group. Same-region worker attachment is later
  work. Single-agent tests are not cross-worker acceptance.

`scripts/shared-wasm-memory-browser.test.ts` runs the shared fixture in a real group guest in
Chromium, owned by `checks/browser-guest-shared-wasm-memory.json`. The Shared PIC job consumes
its one group build. That gate selects on the nested host, the executor and launcher and this
consumer. Other web files keep to their ordinary web gates, so they do not compile native code.

The published package includes `web/src/nested/` alongside its worker sources,
so packed consumers can resolve the same host and wire types. The existing
packed-consumer gate checks all three files and the real TypeScript/Vite closure.
