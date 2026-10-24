## Quality checks and original adapters

The quality runner, failure probes, lint/unused/clone configurations, TypeScript
projects and CI wiring are original bun-wasm tooling. Existing original package,
filesystem, subprocess, shell, native-stream, crypto and browser test adapters
get typed test doubles, checked entrypoints and named control-flow helpers.
The preview WebSocket declaration describes our bundler's export of the existing
classic-script factory; it does not import another WebSocket implementation.
The JSC Rust adapter retains its raw engine-value API, with a specific documented
Clippy exception for those engine-owned handles. The source ledger's prior
classifications and upstream paths still apply to each mixed file.

Host builds now link the existing native glue and bundler hooks too, so workspace
examples and tests resolve the same ABI symbols as WASI builds. Machete exceptions
name dependencies referenced only by unchanged path-included Bun modules. Browser
fixtures keep consumer-local build inputs but leave Playwright profiles under the
short host temporary root, avoiding Chromium Unix-socket path limits.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Quality checks and original adapters](#quality-checks-and-original-adapters) | Host feature | Original quality commands and tighter host/test typings, with small control-flow extractions. |

[Ledger scope and pinned revisions](scope.md).
