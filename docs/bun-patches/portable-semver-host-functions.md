## Portable semver host functions

Class **Port** for the source selection in `crates/bunwasm-semver/src/lib.rs`.
The upstream implementation is oven-sh/bun `src/semver_jsc/SemverObject.rs`
at pinned upstream revision `a7733435cf40429e3b35c36072769df2052b80f1` (Bun 1.4.5).
The vendored patched tree is `13db39ec6c7f348f48a660c0b8b7d9a6a0051cc0`.
This file is unchanged between those revisions. The adapter compiles it directly with
`#[path]`, so no copy or generated rewrite can drift from the pinned source.
Its `order`, `satisfies`, and `intersects_for_testing` bodies all compile.

Bun 1.4.5 moved `order` and `satisfies` to its bindgen: they take UTF-8 bytes
(`order` also a `JsHeap` for its error) and return `bindgen::Result`, and
`SemverObject.bind.ts` generates the JavaScript entry points. The file no longer
has a `create` function table. The glue in `crates/bunwasm-semver/src/lib.rs`
does what the generated entry points do for these two functions.

Class **Host feature** for the original adapters in `crates/bunwasm-bun-jsc/`,
`crates/bunwasm-bun-jsc-macros/`, `crates/bunwasm-semver/src/lib.rs`, and
`crates/bunwasm-runtime/src/semver.rs`, `crates/bunwasm-runtime/src/js/bun.js`, and
the GC hook in `web/src/engine-host.js`. These implementations are ours.
They provide the source-compatible names, the `bindgen::JsHeap` and `bindgen::Result`
stand-ins, and the free-host-function macro needed by this
one module. They use call-scoped string slots, immediate boolean and int32 results,
and explicit errors instead of JSC's tagged values and C++ call ABI.
The runtime adapter maps the three functions `bunwasm_semver::functions` lists to their native names.
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
