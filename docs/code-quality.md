# Code quality

Run both groups of blocking checks from the repository root:

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
and incremental compilation to limit runner disk use.

CI runs `bun run quality --javascript` on every PR and main push. The package
job owns `tsconfig.package.json`; the web job owns the runtime-factory type check.
`quality:types` owns the scripts/site and broader web/sandbox quality projects.
The quality negative controls still rerun individual gates with invalid input.
Those are required failure checks, not duplicate successful coverage.

The same always-on job is the sole owner of the lightweight CMake preflight suite.
It runs independently of native selection, so changes to its tests, timeout helper,
shell entry points, shared helpers or shim inputs cannot skip the suite. These
checks configure tiny fixtures; they do not build JSC, BoringSSL or Rust.

The CMake suite detects real native C/C++ compilers once, backs up that fixture,
and restores it at the same absolute path after each case. Every case still runs
CMake to generate its own cache and Ninja rules, including the COMPILE/LINK
sysroot overrides. The backup is not a relocatable build or a compiler stub.
A regression checks that native and foreign-sysroot rules differ without repeating
compiler identification or ABI probes. Both the initial detection and each
reconfiguration retain the 15-second process-tree deadline. Failed configures
print stdout as well as stderr, so compiler-probe progress is not lost.

This removes redundant compiler probes from the cache-guard tests. Main run
`39443166670` timed out in a static C ABI archive probe, with `ar` in state D.
The same suite passed locally with both deadline-wrapper versions, so the hosted
stall's underlying cause is not established and is not attributed to the wrapper.
The initial real compiler detection remains subject to host failures.

The existing Rust job runs `bun run quality --native` only when native inputs
change. `scripts/ci-changes.ts` examines the entire Git diff, including deleted
and renamed files, with no API path-count limit. It uses the PR merge base or
both endpoints of a main push. Invalid or unavailable comparisons fail the
quality job instead of skipping Rust. Native inputs include crates, upstream
sources/patches, Cargo config/manifests/lock, pinned toolchains, build/source-sync
scripts, the quality drivers, this workflow, and the root dependency lock.
The WASI crypto toolchain, its CMake cache preflight dependencies, and the shared
process-request JSON compiled into host tests also select native checks.
Registered native fixture directories, their server inputs, the fixture launcher, and the
FS, VM, and HTTP production-source checks also select the same native job.
Browser-only and documentation changes install no Rust toolchain or SDK.

Host Clippy covers all test/example targets once. Host tests run once, in release
mode, including integration and documentation tests. Both WASI feature graphs
remain checked; their features are not interchangeable. All Clippy commands use
`--no-deps` so upstream dependencies compile but do not become lint targets.

The native job keeps `CARGO_TARGET_DIR` at the explicitly cached workspace
`target/`, rather than an uncached runner-temp directory. It caches the complete
Cargo target and registry, including vendored path dependencies, test binaries
and workspace crates. Swatinem's target cleaner excludes in-repository path
dependencies outside the workspace, including Bun's large parser crates; the
native job uses an explicit cache instead. The pinned nightly uses checksum
freshness for Rust source. Cargo still uses
modification times for build-script inputs. `quality-input-times.ts` records
content hashes and timestamps inside the cached target. Before compiling, it
restores timestamps only for unchanged files and directories under the owned
source/build-input roots. Changed, added or renamed inputs get a fresh time.
This keeps a fresh checkout from rebuilding every embedded runtime or C archive,
without hiding real edits. Symlinks are fingerprinted without modifying targets.
Rustup, Bun downloads, pinned
upstream sources, and WASI SDK/sysroot each have caches. The sysroot cache key
includes the runner image and builder/dependency inputs; its existing receipt
still verifies every tool and archive. Rust cache keys include upstream patches,
third-party inputs, the WASI crypto toolchain, CMake preflight dependencies and
native gate/build scripts. Cargo explicitly watches the crypto toolchain, and
the timestamp receipt fingerprints it too. A source hash refreshes the cache
after crate or compiled process-request fixture edits, with a same-toolchain/input
restore prefix for reuse.
Cache logs show restored paths,
keys, sizes and hits. A hit alone is not proof that Cargo reused build output.

Moving native work to the PC or UpCloud requires an owner-approved runner or
an authenticated dispatcher. CI does not silently skip those checks when no
private executor is configured.

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
  Only `web/tests/next-framework-cache-probe.ts` excludes unlisted-dependency
  diagnostics because the runner copies it into the guest fixture, where Next is
  declared and installed. Host imports of Next remain errors. No host Next package
  is installed for that probe.
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
  cargo-machete 0.9.2. Tests run in release mode. No whole authored crate is excluded. These are native-host
  default-feature checks.
- `quality:wasi` runs locked production Clippy on `wasm32-wasip1` with
  `-D warnings`, once with QuickJS defaults and once with the browser build's
  `engine-host,bun-transpiler,bun-build` features and no defaults. Both commands
  explicitly select the ten authored production crates: CLI, runtime, build,
  glue, POSIX, semver, crypto-sys, transpiler, the engine-independent bun-jsc
  shim and its host proc-macro. Dependencies alone are not
  Clippy primary packages. WASI SDK 34.0 is required. The quality environment
  removes `RUSTFLAGS` and `CARGO_ENCODED_RUSTFLAGS`, replaces the target's warning
  cap with `-C link-self-contained=no`, and leaves the general build environment
  unchanged. Native `--all-targets` cannot see these WASI-only paths.
- After both target configurations pass, the WASI gate temporarily appends a
  `needless_bool` violation to the actual cfg(wasi) POSIX library. A focused
  production Clippy command for the POSIX crate must reject it with exit 101 and the expected lint
  and source path. The probe restores the original bytes in `finally`; signal
  handlers stop its Cargo process group before restoration. A compile-only gate
  cannot satisfy this control.

The WASI JSC engine and lint/format tools are not included in that target check.
Their build scripts require generated WebKit headers, JSC archives and a Yarr
compile database from `scripts/build-jsc.sh`. A stock WASI SDK cannot provide
those artifacts. Their host workspace code remains checked, but this is not a
claim of full WASI JSC/tools coverage. Run their existing supported build scripts
with the matching JSC build inputs to verify that separate configuration.

## Upstream boundaries

`vendor/` and `third_party/` contain pinned upstream implementations and patches.
They compile as dependencies but do not inherit our formatting/Clippy policy.
Bun's own rustc deny settings remain active. Patch 0013 fixes WASI cfg gaps and
allows only `dead_code` on named native poller/watcher items unused on WASI.
There is no crate-wide warning cap or new authored-source lint suppression.
Unchanged dependency warnings, such as Wasmi's, remain visible.
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
