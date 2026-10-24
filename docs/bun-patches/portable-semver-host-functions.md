## Portable semver host functions

Class **Port** for the source selection in `crates/bunwasm-semver/src/lib.rs`.
The upstream implementation is oven-sh/bun `src/semver_jsc/SemverObject.rs`
at pinned upstream revision `9510e74152073d850a18758ca41114d8f214ffa6`.
The vendored patched tree is `4ceda2c2868d3a7703c7737ddd9de7244ec384df`.
This file is unchanged between those revisions. The adapter compiles it directly with
`#[path]`, so no copy or generated rewrite can drift from the pinned source.
Its `order`, `satisfies`, and `intersects_for_testing` bodies all compile.

Class **Host feature** for the original adapters in `crates/bunwasm-bun-jsc/`,
`crates/bunwasm-bun-jsc-macros/`, `crates/bunwasm-semver/src/lib.rs`, and
`crates/bunwasm-runtime/src/semver.rs`, `crates/bunwasm-runtime/src/js/bun.js`, and
the GC hook in `web/src/engine-host.js`. These implementations are ours.
They provide the source-compatible names and free-host-function macro needed by this
one module. They use call-scoped string slots, immediate boolean and int32 results,
and explicit errors instead of JSC's tagged values and C++ call ABI.
The runtime adapter maps the actual upstream function table to its native names.
`crates/bunwasm-runtime/src/js/builtins.js` exposes the upstream intersection function
through the existing internal test module. JavaScript still owns argument coercion.
The public semver wrapper rejects Symbol primitives with Bun's canonical error
message. The host GC adapter captures the host's original function before user
code can replace it. Bun's upstream harness replaces global `gc` with a wrapper
around `Bun.gc`; looking up global `gc` on every call otherwise recurses.

This replaces our duplicated semver host-function logic, while retaining the existing
pure Bun semver parser used by package installation. See
[the backend spike](../bun-jsc-backend.md) for the limits of this subset.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-semver/src/lib.rs`](#portable-semver-host-functions) | Port | Compile Bun's semver host functions unchanged against a portable `bun_jsc` subset. |
| [`crates/bunwasm-bun-jsc/`, `crates/bunwasm-bun-jsc-macros/`, runtime semver and host GC adapters](#portable-semver-host-functions) | Host feature | Original adapters connect Bun's host functions to the shared data-native interface and preserve the host GC hook. |

[Ledger scope and pinned revisions](scope.md).
