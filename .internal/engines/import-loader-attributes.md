# Text import correction

Status: Approved, implementation in progress. Engines owns review and landing.

Runtime file preparation lowers static text requests to process-owned tokens. Resolved text files receive separate module names and generated string-only ESM exports. Ordinary HTMLBundle, CommonJS resolution and the Engine interface stay unchanged.

This change owns shared runtime loading, the transpiler and CLI adapter, browser import loading hooks, the narrow Bun direct re-export metadata patch, and feature-owned controls. It does not own preview routing, engine C++, shared memory, framework templates, or dependency versions.

Generated Function/eval/vm and require-of-ESM paths are outside this file-import acceptance claim. The implementation checkpoint and runnable commands live in the Engines report, not in public documentation.

## Implementation checkpoint

The shared correction is implemented. Engines owns the final independent source
review, CI, and merge. An open PR is not completed work.

The dependency-free fixture passes on QuickJS, JSC, SpiderMonkey interpreter,
browser store modules, and browser record modules with context hooks. Each run
also passes source-cache, engine-modules, default-import-reexport, and the existing
TypeScript stack-trace control. Compiler controls cover preserved extensions,
dynamic options, direct re-exports, and invalid static attribute syntax.

Hermes factory-before-bootstrap initialization is covered by the shared loader
control, using its existing three native methods. No retained Hermes side was
included in the supplied component inventory, so a live Hermes pass is not claimed.
The supplied SpiderMonkey native configuration enables the portable baseline
interpreter. Its focused run is separate from the default-interpreter result.

## Next Hono blocker

Both real Chrome cells now install, start, render `Hello from hono`, and click the
counter from zero to one. Both stop at the original 180,000 ms hot-reload deadline.
The maintained runner does not reach build or preview after that failure.

The unchanged Hono template runs `bun --hot run server.ts` and imports its page
once as text. `crates/bunwasm-cli/src/main.rs` preserves `--hot` through the generic
flag branch near line 808, but no runtime or playground handler consumes it.
`rg -n -- '--hot|--watch|hot_reload|hotReload|watch_mode' crates web/src sandbox`
finds the template and unsupported bundler-watch stubs, not a reload mechanism.
The text fixture proves that an evaluated ESM namespace stays cached and a fresh
process sees edited contents. Invalidating that namespace would violate this
fix's accepted cache contract instead of implementing hot reload.

Evidence is under `/work/reports/goals/engines/import-loader-attributes/implementation/`.
`hono/TABLE.json` contains the JSC attempt and `hono-sm/TABLE.json` contains the
SpiderMonkey attempt. Both report browser, preview, foreground, and server cleanup.
Current-main discovery at the implementation base hardcodes SpiderMonkey as
unregistered. The SM attempt therefore consumes the supplied immutable c9afec99f
maintained runner modules without editing the separate runner PR. Its exact source
is recorded in `sm-runner-source.txt`. No goal table outside this task was changed.
