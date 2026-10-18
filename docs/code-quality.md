# Code quality

Run the same blocking command as the PR/main CI job from the repository root:

```sh
source env.sh
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
(cd sandbox && bun install --frozen-lockfile)
(cd site && bun install --frozen-lockfile)
scripts/sync-bun.sh
scripts/sync-crypto.sh
cargo install cargo-machete --version 0.9.2 --locked --jobs 1
# WASI_SDK_PATH must contain WASI SDK 34.0. CI verifies the release archive hash.
bun run quality
```

On this machine, run the last command through the shared heavy runner. Use one Rust
compile job by default; `QUALITY_RUST_JOBS` can raise that on larger runners.
The command stops at the first failure. Existing package, bundle, browser and
runtime test jobs remain separate blocking checks. CI disables Rust debug symbols
and incremental compilation to limit runner disk use; it runs the same checks.

## Coverage and versions

- Oxlint 1.88.0 checks owned JavaScript and TypeScript, including runtime polyfills,
  package code, web, sandbox, scripts and tests. Correctness and unused-variable
  rules are errors, control-flow depth is limited to 3, and complexity to 40.
  Unqualified browser-global `name` is forbidden, so a renamed local cannot
  silently capture `window.name` inside a callback.
  Guest fixtures deliberately testing invalid input under `tests/fixtures`,
  `tests/build` and `tests/jsc` are not host source. Intentional classic-script
  factory evaluation and ABI-specific operations have local explained exceptions.
- TypeScript 7.0.2 runs strict runtime-factory, package, scripts/site, web and sandbox projects.
  Both application quality projects include authored TS test files and their
  browser/worker entrypoints. Legacy JS gets correctness lint, not a claim of
  strict JS type coverage. The existing runtime factory type tests remain in CI.
- Knip 6.41.0 checks unused files, exports, types and dependencies. Package exports
  and package commands are discovered by its plugins. Explicit entries describe
  scripts called from shell/Python, browser-bundled guests, workers and benchmark
  fixtures whose paths are passed to bundlers dynamically. They are not a list of
  every source file. `benchmark:` is a build-time module namespace; `unshare` and
  `ss` are OS commands; `build.mjs` runs in the upstream streams checkout. The
  unresolved Unicode/space fixture specifier is intentional guest input.
  `process-bench-baseline.ts` compiles against a frozen Git snapshot in the benchmark
  runner. Its retired imports are deliberately unresolved in the current tree; it
  stays linted and clone-scanned, but is excluded from the current-API type project.
- jscpd 5.4.1 checks owned TS, JS and Rust together. Exact scans use mild token
  matching, at least 100 tokens and 10 lines. Structural function comparison uses
  `--similarity 0.8` and at least 40 AST nodes. The larger node floor avoids
  trivial getter/forwarder matches. jscpd itself omits test functions from its
  structural analysis; exact matching still includes the configured tests.
- Rust uses `nightly-2026-09-15`, the existing pinned Bun toolchain. Every authored
  Rust file under `crates/` is formatted, then all 14 workspace crates and all host
  targets get Clippy with `-D warnings`, locked workspace tests, and
  cargo-machete 0.9.2. No whole authored crate is excluded. These are native-host
  default-feature checks.
- `quality:wasi` runs locked production `cargo check` on `wasm32-wasip1`, once
  with the CLI's default QuickJS features and once with exactly the browser build's
  `engine-host,bun-transpiler,bun-build` features and no defaults. WASI SDK 34.0 is
  required. This checks the WASI-only POSIX implementation and guest ABI paths,
  which native `--all-targets` cannot see. It is a compile check, not execution or
  a second warnings policy: it retains the existing WASI upstream warning cap
  from `env.sh`; the native owned-source Clippy gate still denies warnings.

The WASI JSC engine and lint/format tools are not included in that target check.
Their build scripts require generated WebKit headers, JSC archives and a Yarr
compile database from `scripts/build-jsc.sh`. A stock WASI SDK cannot provide
those artifacts. Their host workspace code remains checked, but this is not a
claim of full WASI JSC/tools coverage. Run their existing supported build scripts
with the matching JSC build inputs to verify that separate configuration.

## Upstream boundaries

`vendor/` and `third_party/` contain pinned upstream implementations and patches.
They compile as dependencies but do not inherit our formatting/lint policy.
Three unchanged Bun graph modules included with `#[path]` are explicitly marked
at their inclusion sites. Authored graph facades, Rust adapters and JS polyfills
remain checked. rustfmt uses an explicit owned file list and `skip_children=true`
so following those module paths cannot reformat Bun's source.

The generated bundles `temporal.js`, `streams_polyfill.js`, `node_stream_core.js`,
`ws_builtin.js` and `bun_console_constructor.js`, plus generated guest metadata,
are excluded from lint/clone scans. Their generators and authored wrappers stay
covered. See [the source ledger](bun-patches.md) for provenance.

## Fixed duplicate baseline

`.jscpd-baseline.json` records native clone fingerprints, not a percentage budget.
`quality:duplicates` uses `--baseline`, `--fail-on-new-clones 0` and
`--fail-on-empty`. Renaming a local variable does not bypass structural Rust
comparison. Removing one baseline clone does not buy room for a different clone.
The initial baseline contains 21 clone pairs, including 8 Rust pairs,
with 459 files scanned. Five TS pairs come from test setup added by main while
this PR was being implemented: two poll-test pairs, two runtime-root fixture pairs, and one
spawn-outcome test pair. They are recorded in this initial baseline, not admitted by
a percentage allowance. Refresh counts
with the current scan when reviewing a baseline edit.

Do not update the baseline to make an unexplained regression pass. If an
intentional duplicate is necessary, review its source and the baseline change
in the same PR. The explicit maintenance command is:

```sh
bunx --no-install jscpd --config .jscpd.json --baseline .jscpd-baseline.json --update-baseline --fail-on-empty
```

`quality:probes` injects temporary unused-variable, ambient-global, type, unused-file, exact-duplicate and
structural-Rust violations and verifies each real gate fails. The baseline must pass before any injection. Every synthetic
file is removed in `finally`. The structural probe changes names, literals and
one statement, so it does not merely prove exact matching twice.

Run individual checks with `bun run quality:lint`, `quality:types`,
`quality:unused`, `quality:duplicates`, `quality:probes`, `quality:rust` or
`quality:wasi`.
Apply Rust formatting with `bun scripts/quality-rust.ts --write`.
