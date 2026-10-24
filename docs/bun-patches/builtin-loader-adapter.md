## Builtin loader adapter

Class **Host feature**. `scripts/generate-bun-builtins.mjs`, its shell runner, the selection manifest, and `crates/bunwasm-runtime/src/js/bun_builtins.ts` are original adapters. `src/js/bun_builtin_globals.ts` is the original bootstrap capture of intrinsic constructors, before application code can replace public globals. They call Bun's codegen and consume its generated module protocol. They do not copy the codegen implementation. Rust source lookup and Engine natives are original bun-wasm glue. The loader uses lazy factories, isolated caches, explicit unsupported errors, and the existing builtin implementations for dependencies not switched yet. Its strict TypeScript annotations describe the generated factory protocol, registry indexes, private symbols and captured intrinsic constructors; no generated builtin output is edited. [bun-builtins.md](../bun-builtins.md) records its limits and hook status.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/generate-bun-builtins.mjs`, `src/js/bun_builtins.ts`, `src/js/bun_builtin_globals.ts`](#builtin-loader-adapter) | Host feature | Generate the selected builtin closure and load factories through Engine. |

[Ledger scope and pinned revisions](scope.md).
