# WebAssembly Globals

Support is **PARTIAL**. `WebAssembly.Global` constructs numeric `i32`, `i64`, `f32`
and `f64` globals, mutable or immutable. They use real Wasmi storage in every
JavaScript engine. Ordinary modules import the same storage: JavaScript writes,
Wasm writes and reentrant callbacks see each other's changes immediately.
Aliases and ordinary re-exports return the same live JavaScript wrapper.

Constructor-created globals cannot enter the separate shared-memory backend.
Those imports throw `WebAssembly.LinkError` before the importing module starts,
including when the global has passed through ordinary aliases or re-exports.
This is not full standard cross-backend interoperability.

The existing shared-memory backend still accepts immutable numeric globals
exported by Wasm modules through scalar transport. Mutable globals are never
copied to scalars. Nested mutable global imports remain unsupported. Reference
and `v128` constructors are unsupported and throw `TypeError`.

The runtime Store owns backend globals. JavaScript wrapper caches are weak;
an importing instance retains the storage when its creator wrapper is collected.
A failed instantiation does not publish an instance or global handles, but writes
to already-imported globals before a start-function trap remain visible.

Run the source bridge controls with `source env.sh` and
`bun test scripts/wasm-tables.test.ts`. The `wasm-globals` native fixture runs on
QuickJS, JSC, SpiderMonkey and Browser. The shared-group `globals` fixture entry
checks explicit cross-backend rejection beside the existing immutable controls.
