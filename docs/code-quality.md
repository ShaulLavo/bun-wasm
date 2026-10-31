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

This removes redundant compiler probes from the cache-guard tests. A hosted run once timed out in a static C ABI archive probe, with `ar` in state D. The cause of that stall is not established.
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
Browser-only and documentation changes install no Rust toolchain or SDK.

The JSC C/C++ prebuild runs in its own job, `JSC C/C++ prebuild`, selected exactly
when the native job is: the tools fixture links JSC even when no JSC engine gate
runs. It owns the run's one patched sysroot and one prebuild, and their caches. It
restores or builds the sysroot, then builds the prebuild or verifies a restored one
in its own process group. Cancellation kills and reaps only that group. On main it
saves the prebuild cache before packaging. It then packs both trees into one
`jsc-prebuild` artifact. A manifest binds the artifact to the run ID, the commit,
both absolute paths and both archive hashes, and the job reports the manifest hash
as an output.

The native job needs the prebuild job but does not skip when it fails or is
skipped. Its first step fails unless the prebuild job succeeded, so a missing
prebuild turns the native check red instead of grey. Only the change filter, a
failed quality job or a cancelled run skip it. Before any native check, it
downloads the artifact. It checks the reported manifest hash, the run, commit and
paths, and both archive hashes, and refuses to overlay an existing tree. Then it
extracts both trees at the same absolute paths and runs `check_jsc_inputs_stamp` in
its own environment. That check covers the toolchain, sysroot receipt, WebKit tree,
archives and CMake state. `bun scripts/build-wasi-sysroot.ts` then verifies the
imported sysroot against the native job's own tools. The prebuild log joins the
always-run guest diagnostic upload.

The `Native quality checkpoint` job has a 45-minute guard. It runs the complete
native quality step and the existing main-only quality cache checkpoint. It alone
restores native Cargo state. It packs that target, Cargo registry/git sources,
dependency checker, and prepared Bun/BoringSSL sources into a one-day run artifact.
The existing native job keeps its name and 60-minute guard, imports this state,
and runs all the remaining producers, compiler-backed runtime probes and fixtures.
The JSC prebuild keeps its 45-minute guard. Individual timeouts do not change.

The native handoff binds a closed three-archive list and digests to the run,
producer attempt, source SHA/tree, absolute paths, effective tool/flag fingerprint,
sysroot receipt and original JSC artifact digest. The consumer rejects foreign,
missing or corrupt state and existing destination roots before importing. It
reconstructs minimal Git configuration without credentials, verifies the restored
Bun Git identity and clean tracked source, then runs the real `sync-bun.sh --check`.
The archives preserve file modes, symlinks and mtimes. Source timestamp repair and
all existing receipt, memory and toolchain guards still run. No import failure
falls back to rebuilding or an older cache. No checkout `.git`, Git configuration,
Cargo credentials, hooks, logs, environment dump or untracked dependency installs are transferred.
Git-tracked dependency fixtures remain public source, even under `node_modules`;
their untracked siblings stay excluded.
Only the Git objects, refs, HEAD, index and shallow metadata needed by public
source verification cross the boundary. External Git object alternates and linked
worktree metadata are rejected rather than followed.

On a failed-jobs-only retry, a successful quality job can remain from an earlier
attempt. The consumer selects the artifact and expected attempt from that actual
producer's outputs, not its own current attempt. The manifest still requires the
same run, source and toolchain. A rerun of the quality producer creates an
attempt-specific artifact and publishes its new digest only after packaging.
A needed failed, cancelled or skipped quality producer explicitly fails the
existing native check. Documentation-only selection and downstream Hermes and
Processes conditions are unchanged.

Cold-run evidence reached Web checks at 59m50s, including 24m59s of native quality.
The partition leaves 34m51s of that observed work in the consumer, before transfer
cost and unfinished Web checks. These are partitions, not measured after timings.
Actual archive bytes, transfer cost, Cargo freshness and cold compliance must be
recorded from the first real handoff. A warm run is not cold proof.

One Cargo build overlaps others. Right after the native quality checkpoint,
`Start the JSC Cargo guest build` runs `build-bun-jsc.sh` in its own session at
`nice -n 19`. It writes only the private JSC Cargo target, `dist/bun-jsc.wasm*`
and its own temporary files. Meanwhile the foreground builds the host launcher,
the QuickJS core and the host-engine guest, which read none of those. `Build the
JSC Cargo guest` then waits for it, prints its log and fails with its exit status,
or fails if the process died without one. Its cache save and the embedding checks
follow. Timed checks (native fixtures, tools, Web guests) start only afterwards:
some subprocess limits are 4 s for work that takes 2.8 s on an idle runner, and a
concurrent build pushed them over it.

Host Clippy covers all test/example targets once. Host tests run once, in release
mode, including integration and documentation tests. Both WASI feature graphs
remain checked; their features are not interchangeable. All Clippy commands use
`--no-deps` so upstream dependencies compile but do not become lint targets.

The native job keeps `CARGO_TARGET_DIR` at the explicitly cached workspace
`target/`, rather than an uncached runner-temp directory. It caches the complete
Cargo target and registry, including vendored path dependencies, test binaries
and workspace crates. Swatinem's target cleaner excludes in-repository path
dependencies outside the workspace, including Bun's large parser crates; the
native job uses an explicit cache instead. The job sets checksum freshness, but
the pinned nightly ignores it (rustc gets no checksum flag), so Cargo decides
freshness from modification times for Rust sources, embedded files and
build-script inputs alike. `quality-input-times.ts` records
content hashes and timestamps inside the cached target. Before compiling, it
restores timestamps only for unchanged files and directories under the owned
source/build-input roots, including the `tests/` files the runtime embeds.
Changed, added or renamed inputs get a fresh time. It runs again right after the
WASI lint probe, which rewrites a source file. The rustup cache holds every
`rust-toolchain.toml` component, so rust-src keeps its timestamps and the QuickJS
engine's `-Zbuild-std` target stays fresh.
This keeps a fresh checkout from rebuilding every embedded runtime or C archive,
without hiding real edits. Symlinks are fingerprinted without modifying targets.
Rustup, Bun downloads, pinned upstream sources, the fixed WASI SDK and the patched
sysroot each have caches. The sysroot cache key includes the host build tools and
builder/dependency inputs; its existing receipt still verifies every tool and
archive. The refined Cargo cache keeps upstream patches, third-party inputs, the
WASI crypto toolchain, its CMake toolchain and guard, and Rust gate/build inputs.
Cargo explicitly watches the crypto toolchain and CMake guard, and the timestamp
receipt fingerprints those source files too. JSC-only CMake checks and Binaryen
stay in a separate JSC prebuild cache. Its private Cargo target has its own cache
identity, with the same C++/sysroot/toolchain inputs plus the Rust and Cargo inputs
that can affect that target. A Rust-only edit therefore keeps the validated prebuild
candidate while rebuilding the affected Cargo artifacts. The old full native key
remains as a fallback while the refined layer proves reuse. A source hash refreshes each cache
after crate or compiled process-request fixture edits, with a same-toolchain/input
restore prefix for reuse.
Cache logs show restored paths,
keys, sizes and hits. A hit alone is not proof that Cargo reused build output.

Moving native work to an external machine requires an approved runner or
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
  `process-bench-baseline.ts` compiles against a frozen Git snapshot in the benchmark
  runner. Its retired imports are deliberately unresolved in the current tree; it
  stays linted and clone-scanned, but is excluded from the current-API type project.
- jscpd 5.4.1 checks owned TS, TSX, JS and Rust together. Exact scans use mild token
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
in the same PR.

The assert/util strict TypeScript conversion migrates exactly one existing
fingerprint, `559db8d4f8200ec1` to `432876565c1cd6b7`, with count 1 unchanged.
Both identify the same 21-line error-formatting clone in the adapted implementations.
The original JavaScript has 178 tokens; erased type annotations raise the typed
scanner count to 196. The migration preserves the original runtime AST and token
positions instead of extracting shared code. `scripts/runtime-assert-util.test.ts`
pins that proof, and the typed-adapter copy probe still rejects new duplication.
This remains a separate one-for-one format migration, not room for a different clone.

The site's two pages are separate Remix 3 apps over different page models. Their
root components are one recorded structural clone (`887d24fd0e8ffb40`, 15 lines):
each subscribes to its own model's `change` event and lays out its own header and
panes. Sharing that would need a generic root taking a model and children, a layer
that saves one line.

Components can be shared between the pages. The terminal Copy button lives in
`web/src/copy-button.tsx`; the sandbox bundles it with `web/`'s install of
`@remix-run/component`, as it already bundles `bash-web` and the `waffle-*`
programs from `web/`. That second install adds 1,247 bytes of JSX, mixin and `on`
code to the sandbox page (+1,364 bytes raw, +468 gzipped on the built `main.js`).
The button works on both built pages in Chromium.

Integrating the already-converted events module with typed util also migrates the
existing 12-line events/util error-formatting clone from `33ad45a23a9c5c95` to
`f35a9b37be0e8d3c`, with count 1 unchanged. The scanner reports 107 original
JavaScript tokens and 109 TypeScript tokens, including the typed signature at the
clone boundary. The entire describeReceived bodies remain byte-identical to
original source `ac43127c85addabed7e0c2a4883247ae074e858c`; only parameter types
were added. Each conversion alone separates the pair into different scanner
formats; their integration restores the same pair in TypeScript. No implementation
was copied or refactored for this correction. The total remains 21 baseline
entries with count 1 each. The other 19 entries, scan configuration and
zero-new-clone limit stay unchanged. Both existing copy-rejection probes remain
blocking.

The explicit maintenance command is:

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


## CI work ownership and measurements

The package job's locked install runs `prepare` and builds the package once.
Quality and native installs use `--ignore-scripts`; their checks consume source,
not the generated package. The process-bundle job builds the supervisor,
interruption and process-pipe fixtures once, then all three browser jobs download
that run's artifact. Browser tests still run separately in each engine, including
isolated dependency installation. Missing artifacts fail, rather than rebuilding.

Native selection ignores root version-only bumps. Root dependency or command
changes still select native checks, as do `scripts/test.sh` and the node-misc
fixtures. The second input-timestamp restore, after the required failing WASI
lint probe, prevents unchanged release inputs from appearing newly edited.

Native tool setup first checks the runner's existing commands and libclang.
Only missing tools require apt; that fallback removes the known slow HTTP mirror.
The fixed SDK cache no longer includes the changing patched sysroot. Native
cache restore/save are separate; only a cache miss writes a complete snapshot
after the launcher check passes. Keys identify inputs, never run IDs or attempts.
Only quality writes the shared Bun download cache. Other jobs restore it.

`native-cargo-v2` puts compatibility inputs before the Cargo and source hash.
The restore prefix retains the OS, architecture, host build tools, Rust toolchain,
Cargo config, SDK and job configuration, upstream pins and patches, native C/C++
sources and build scripts, and sysroot inputs. The workflow itself is hashed so
an SDK pin or compiler-command change cannot select an incompatible v2 target.
Host build tools means the `--version` output of the compilers, CMake, Ninja,
Make, NASM, pkg-config, the JSC code generators (Ruby, Perl, Python, gperf,
Bison), glibc and libclang. The runner image version is not part of any Rust
key: image updates change many unrelated packages, and keying on them forced a
cold JSC and Cargo rebuild (about 48 minutes) on every image rollout.
`Cargo.*` stays in the exact-key suffix. Cargo validates manifest, dependency,
feature, profile, and Rust source fingerprints after a compatible prefix restore.
The existing input-time check restores timestamps only for unchanged content.

This namespace change cannot match old `native-cargo-v1` or `native-v4` entries.
The first eligible run needs a new v2 snapshot unless the narrower `native-v4` fallback matches. Its compatibility prefix is
unchanged; its primary and save keys now also identify the tools builder and
workflow producer. That fallback runs only when v2 restored nothing,
so it cannot overlay a v2 prefix hit. All four final saves follow the tools producer, both blocking Web guest gates,
selected JSC checks and host output production, and exact hits do not save again. Later compatible
main-run logs must show the actual restored key and compile counts before any
savings claim. Historical cold and warm timings do not measure this change.

To compare completed runs and keep timestamped cache/build evidence:

```sh
bun scripts/ci-report.ts RUN_ID ATTEMPT > summary.md 2> cache-build-evidence.log
```

The optional attempt selects one rerun. Total execution wall time spans its first
job start through its last job finish, excluding queue time and pauses between attempts.

Inspect `gh api --paginate repos/ShaulLavo/bun-wasm/actions/caches` before
changing cache policy. Closed PR caches are isolated from later PRs but still
consume the shared quota. Pull requests save the native and JSC Cargo
snapshots only when they restored nothing compatible: re-saving a compatible
restore added 1.4 GB per push and evicted main's entries, including the 2 GB JSC
prebuild. Remove only identified obsolete entries, not live
branches or the main-branch toolchain/build caches. Process bundles are short-lived
run artifacts, not more entries in the repository's cache quota.
