### Node inspection

`crates/bunwasm-runtime/src/js/inspect.js`, `createNodeInspect`. Class **Port**. Upstream `src/js/internal/util/inspect.js` at the Bun pin, itself Node's MIT-licensed inspection implementation.

Retain substantial inspection and format logic, including layout, strings, containers, option handling, and substitution formatting. Replace primordials, Bun intrinsics, internal imports, and native preview helpers with captured ordinary intrinsics, JavaScript emulation, and the local engine hooks. Package the implementation as a factory with `nodeInspect`, `nodeFormat`, and `nodeFormatWithOptions` exports. This makes `node:util` inspection available outside Bun's internal module system. It is distinct from the Bun console formatter in the same file.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/inspect.js`, Node formatter](#node-inspection) | Port | Adapt Bun's Node inspection implementation to ordinary engine intrinsics. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
