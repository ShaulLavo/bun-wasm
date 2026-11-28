# Upstream vs. ours: bun-wasm cutover audit

**Audit date: 28 November 2026.**

The compiler stack already reuses substantial upstream Bun code, while most runtime and package-manager behavior is still maintained locally. The highest-leverage path is to replace the custom runtime resolver, compile upstream `bun_install` behind browser and Waffle backends, fix the POSIX bridge before new upstream callers rely on it, and expand generated upstream JavaScript builtins. A wholesale `bun_runtime` dependency is a much larger JavaScriptCore binding port; Waffle's OS capabilities do not remove that coupling.

## 1. Scope, evidence, and architectural rule

Core rule (owner, 2026-11-28): **use as much of upstream `vendor/bun` as possible without sacrificing browser cold-start speed or Wasm size.** Stop extending custom rewrites that later get deleted. Keep speed and size small at the platform boundaries: browser native JIT as default, lazy optional engines, lazy package-manager and tool binaries, browser `fetch()`, and Waffle VFS/OS seams.

| Audit input | Exact identity / treatment |
| --- | --- |
| bun-wasm source | `ShaulLavo/bun-wasm` audited at `2d6c0e5d833be3f11ab75cc4736ca6c0307c4be9` (27 November 2026) and updated for merged PR `#1108` at `e51d22ae7c5d8680393f8012ae7fa23ed4a7be7d` (28 November 2026) |
| Upstream Bun | `oven-sh/bun` at `a7733435cf40429e3b35c36072769df2052b80f1` (Bun 1.4.5), pinned in [scripts/sync-bun.sh](../scripts/sync-bun.sh) |
| Reconstructed vendor commit | `2b7d8ba665744fa92e79a3039fc7bf32eed8d4a8` (source tree `5c9514061652a750f95a7c20e4d1fb53a386b058`) |
| Patch series | 28 files in [patches/bun/](../patches/bun/); 101 upstream files changed, 2,159 inserted lines and 381 deleted lines relative to the pin |
| Repository coverage | All 21 local crate manifests and source trees, [src/](../src/), [web/](../web/), [docs/](../docs/), source generators, build recipes, third-party copies, and reconstructed `vendor/bun` |
| Waffle capabilities | VFS (memory, IndexedDB, OPFS, multi-tab), processes, pipes, signals, PTY (`runtime_proc.pty_*`), `flock`/`fcntl`, `AF_UNIX`, loopback networking, `/etc/machine-id`, WASI threads M1 |
| Verification performed | Exact source reconstruction and `scripts/sync-bun.sh --check`, source/manifest/LOC census, `python3 scripts/bun-jsc-inventory.py --check docs/bun-jsc-inventory.json`, and targeted upstream/local source comparisons |
| Verification limit | Static source audit, not a fresh build, application run, or benchmark. Counts are physical lines including comments and inline tests unless noted otherwise. Directory totals include generated bundles, copied ports, declarations, and tests, so they are neither original-code counts nor binary-size estimates. |

### Decisions

1. **Keep the upstream compiler stack.** Parsing, printing, bundling, CSS, semver, glob, dotenv, data parsers, and lint/check drivers already compile real Bun crates. Trim the remaining wrappers rather than replacing them.
2. **Replace runtime resolution first.** [crates/bunwasm-runtime/src/resolve.rs](../crates/bunwasm-runtime/src/resolve.rs) is a separate 1,036-line implementation even though `bun_resolver` already compiles in this workspace. Its normal installed-package API runs without auto-install, so this cutover stands on its own.
3. **Make upstream `bun_install` the package-manager owner.** After `#1108`, the local installer spans 15,404 physical lines across 29 Rust files (9,450 lines in 16 non-test files, up from 10,474 / 7,335 lines across 27 total / 15 non-test files before `#1108` added `catalog:` support). Upstream `vendor/bun/src/install` is a separate JSC-free Rust crate. Keeping a parallel graph, lockfile, catalog, and hoisting implementation indefinitely duplicates work that upstream already owns. Its concrete HTTP, event-loop, archive, and spawn dependencies need real backend boundaries, and its wasm32 layouts, binary serialization, and target `cfg` arms need qualification.
4. **Migrate public builtins to generated upstream JS.** The generated catalog lists 214 modules, yet only 23 upstream factories are embedded from 12 selected roots. Most public APIs still rely on hand-maintained ports. The generator and loader for wider upstream JS reuse already exist.
5. **Fix the OS bridge before adding upstream callers.** Fake-success `flock`, `ENOSYS` spawn and `socketpair`, fixed process IDs, ignored signals, and a fake event loop live in [crates/bunwasm-posix/src/process.rs](../crates/bunwasm-posix/src/process.rs) and [crates/bunwasm-glue/src/bundler.rs](../crates/bunwasm-glue/src/bundler.rs). Existing JS process paths bypass many of them today; adding upstream Rust callers makes those dormant stubs live.
6. **Keep browser JIT as the default and split optional engines cleanly.** Browser default and lazy artifact loading already work architecturally. Engine side modules still import Bun-specific core callbacks, allocators, loader code, and shared drivers from the QuickJS crate, so separate files are not yet standalone Waffle engine packages.

## 2. Ownership map

Legend: **D** = compiled directly from vendored source; **S** = unchanged source selected outside its original crate; **G** = generated from upstream; **P** = copied, adapted, or translated port; **A** = original adapter or local implementation; **X** = absent, partial, or disabled. Sharing an underlying C library such as SQLite or BoringSSL is distinct from reusing Bun's binding or policy around it.

Paths under `bunwasm-*` live in `crates/`; bare local `install/*` and `js/*` paths live in `crates/bunwasm-runtime/src/`. In upstream columns and section 3.2, `install/*`, `runtime/*`, `spawn/*`, and `event_loop/*` live under `vendor/bun/src/`.

### 2.1 Installer, CLI, run, shell, and tests

| Subsystem | Direct upstream today | Ours today | Blocker and cutover plan |
| --- | --- | --- | --- |
| `install`/`add`/`remove`/`update`/`ci` graph and placement | `bun_semver` parser/query/order; upstream data parsers through the transpiler; `bun_glob::BunGlobWalker` for workspace patterns | [crates/bunwasm-runtime/src/install/mod.rs](../crates/bunwasm-runtime/src/install/mod.rs), `resolve.rs`, `resolve/selection.rs`, `catalog.rs` (added in `#1108`), `overrides.rs`, `local.rs` (29 files, 15,404 total lines; 9,450 non-test lines) | Replace with upstream `bun_install` (`PackageManager`, `PackageInstaller`, `PackageInstall`, `hoisted_install`, `isolated_install`, `PackageManager/processDependencyList.rs`, lockfile and catalog modules). No Cargo JS-engine dependency; real work is concrete network, event-loop, archive, and spawn backends, wasm32 layout/serialization checks, target `cfg` arms, C library alignment, and upward linker callbacks. |
| Fetch, cache, and extraction for installer | No `bun_install::NetworkTask` or `bun_libarchive` usage; shared hashing primitives exist in runtime | `install/io.rs`, `pending.rs`, `early.rs`, `trace.rs`, plus `web/src/net/package-fetch.ts` and `web/src/net/install-cache.ts` (extended in `#1108` with `rewritePackageUrl` and actionable errors) | Keep transport, URL rewriting, and browser caching below upstream package semantics. Browser `fetch()` replaces HTTP/TLS transport. Choose between compiling upstream `libarchive` and a contract-compatible thin archive provider by measured cost. |
| Lockfiles and migration | Upstream JSON/JSONC/TOML/YAML parsing through the transpiler | `install/migration.rs` plus `mod.rs` lockfile equality, writing, sorting, and `#1108` catalog migration | Upstream `install/lockfile.rs`, `lockfile/bun.lock.rs`, `migration.rs`, `pnpm.rs`, `yarn.rs`, `yarn_berry.rs`, `lockfile/OverrideMap.rs`, and `CatalogMap.rs`. Cut over together with the installer rather than maintaining a second serializer. |
| `bunx` and package bins | Upstream behavior referenced in docs, not imported | `install/mod.rs` custom cache, install, and bin selection; `package_scripts.ts` bin lookup | Upstream `runtime/cli/bunx_command.rs` plus `bun_install` bin-linking logic. Reuse after the installer cutover while keeping Waffle executable admission. |
| CLI dispatch and `run` | Upstream version/revision values; parser/transpiler APIs in `main.rs`; no upstream runtime CLI | [crates/bunwasm-cli/src/main.rs](../crates/bunwasm-cli/src/main.rs) (1,323 lines, including ~545 lines of compiler adapter), `tool_args.rs` (340), `build_command.rs` (13) | Upstream runtime CLI lives inside `bun_runtime`, and `run_command.rs` imports `bun_jsc::VirtualMachine`, `JSValue`, and `JSGlobalObject`. Extract engine-free option classification and script policy while keeping engine entry dispatch separate. |
| `--filter`, workspaces, and script DAG | Installer uses upstream glob; no upstream selector or scheduler execution | Previously retained flags in `exec_argv` without executing them; Slice 1 rejects unimplemented scope-changing flags explicitly. `src/package-continuation*.ts` (711 lines) is a Waffle process-lifetime handoff, not a workspace scheduler | Upstream `install/PackageManager/workspace_selection.rs` (624 lines) provides shared name, path, negation, and relational selectors plus `WorkspaceGraph`. `runtime/cli/filter_arg.rs` (428), `filter_run.rs` (1,172), and `multi_run.rs` implement selection and process orchestration. Expose engine-free selection from `bun_install` and drive process execution over Waffle spawn/poll. |
| Package script pre/main/post and npm rewrites | No direct upstream implementation | [crates/bunwasm-runtime/src/js/package_scripts.ts](../crates/bunwasm-runtime/src/js/package_scripts.ts) (284 lines) | Canonical rewriting lives upstream in `install/lifecycle_script_runner.rs`. Reuse upstream rewriting so script behavior cannot diverge; keep process spawning as a thin adapter. |
| `Bun.$` and `bun exec` | Adapted facade from [src/js/builtins/shell.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/builtins/shell.ts) and escaping from [src/shell_parser/parse.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/shell_parser/parse.rs) | `js/bun_shell.ts` (462 lines): quote-state scanning, interpolation, shell process invocation, temp-file redirection, braces | Running the system shell via Waffle is appropriate for package scripts. Running `bash` behind `Bun.$` instead of Bun's interpreter is a semantic substitution. Reuse the JSC-free `bun_shell_parser` crate for escaping and braces directly; full interpreter reuse requires extracting `bun_runtime::shell` from runtime objects. |
| `bun test`, `bun:test`, `node:test` | `bun_text_diff` directly; [crates/bunwasm-runtime/src/print_diff.rs](../crates/bunwasm-runtime/src/print_diff.rs) (632 lines) matches upstream `runtime/test_runner/diff/printDiff.rs` byte-for-byte | `js/bun_test.js` (3,350), `test_matchers.ts` (340), `test_extensions.ts` (92), `test_lifecycle.ts` (86), `fake_timers.ts` (276), `node_test.ts` (35), `test_diff.rs` (68) | Upstream `runtime/test_runner` spans 63 Rust files (18,779 lines) tied to `JSValue`, `CallFrame`, `JSGlobalObject`, `VirtualMachine`, GC roots, and promise scheduling; `test_command.rs` also calls JSC coverage. Source-select pure leaves now; broader reuse waits for a rooted value bridge. |
| `init`, `create`, `repl` | `init.rs` includes upstream `gitignore.default`, `tsconfig.default.json`, `README.default.md` | `init.rs` (296), `main.rs` create dispatch, synthetic REPL JS bootstrap | Lower leverage than installer and `run`. Reuse template assets and engine-free CLI routines over time, using Waffle PTY for terminal I/O. |

### 2.2 Compiler, resolver, primitives, and tools

| Subsystem | Direct upstream execution/source | Local code | Reason for adaptation and cutover judgment |
| --- | --- | --- | --- |
| JS/TS/JSX parser and transpiler | `vendor/bun/src/{bundler,js_parser,js_printer,ast,options_types,sourcemap,resolver}`; [crates/bunwasm-transpiler/src/lib.rs](../crates/bunwasm-transpiler/src/lib.rs) constructs upstream `Transpiler`, parses, and prints | `bunwasm-transpiler/src/lib.rs`, `prepare.rs`, `register.rs`, `record_fixup.rs`, `data.rs` (4,482 total lines across 8 files, including `#1108` YAML scalar handling in `data.rs`) | Parser and printer require C/JSC/WTF link symbols and wasm32/WASI target arms. Source preparation and module-registration records exist because browser engines do not expose JSC's native module-loader API. Keep this preparation adapter narrow; do not grow a second parser. Patches `0008`, `0010`, `0017`–`0023`, and `0025` alter emitted registration, await, and import hooks beyond plain OS `cfg` arms. |
| Public `Bun.Transpiler` | Same upstream parser/printer; `public_transpile` and upstream `TSConfigJSON` parse | [crates/bunwasm-runtime/src/js/bun_transpiler.ts](../crates/bunwasm-runtime/src/js/bun_transpiler.ts) (110 lines) plus wrapper methods in `bunwasm-transpiler` | Public JS argument coercion and result conversion belong at the engine boundary. Route option handling through data-only APIs instead of expanding manual defaults. |
| Build, bundler, minify, splitting, CSS, HTML | `bun_bundler::BundleV2`, `bun_css`, `bun_js_parser`, `bun_js_printer`, `bun_resolver`; [crates/bunwasm-build/src/lib.rs](../crates/bunwasm-build/src/lib.rs) calls upstream `generate_from_cli` | `crates/bunwasm-build/src/lib.rs` (723), `args.rs` (258), `cli.rs` (54), `stubs.rs` (208); entire crate 4,079 lines including tests, generated clients, and `build.rs` | Upstream `BuildCommand` lives inside JSC-bound `bun_runtime`. This wrapper preserves the real bundler and is close to the target design. Native executable compile, bytecode, JS plugins, watch mode, `server_components`, and `react_compiler` stay disabled until callback and thread boundaries exist. |
| Dev server, HMR, Bake graph | Direct `#[path]` inclusion of upstream `runtime/bake/dev_server/{incremental_graph,packed_map,serialized_failure}.rs` in [crates/bunwasm-build/src/dev_server/graph.rs](../crates/bunwasm-build/src/dev_server/graph.rs); generated Bake client JS; upstream `BundleV2` Bake hooks | [crates/bunwasm-build/src/dev_server/](../crates/bunwasm-build/src/dev_server/) (1,951 lines): `mod.rs` (474), `cache.rs` (461), `facade.rs` (224), `graph.rs` (276), `finalize.rs` (348), `hooks.rs` (168) | Native upstream `DevServer` mixes watcher, native routing, server components, locks, and JSC. Keep browser HTTP/WS and file-notification adapters, and extract upstream graph finalization behind a driver context. Existing drift: upstream records JS/CSS print failures in finalization, while local `finalize.rs` omits them. |
| Compiler/build resolution | `vendor/bun/src/resolver/{resolver,package_json,tsconfig_json,...}.rs` (15,541 lines total) and filesystem/cache crates | Dependency-parsing stub in [crates/bunwasm-glue/src/extra.rs](../crates/bunwasm-glue/src/extra.rs); auto-install factory stub in [crates/bunwasm-build/src/stubs.rs](../crates/bunwasm-build/src/stubs.rs) | Ordinary file and package resolution runs upstream. Because `bun_install` is not linked yet, dependency metadata and auto-install hooks stay stubbed. Keep every stub ABI-exact until upstream `bun_install` replaces it. |
| Runtime import/require resolution | No direct upstream resolver call; uses Rust `std::fs`, a local JSON cache, and `host::probe` | [crates/bunwasm-runtime/src/resolve.rs](../crates/bunwasm-runtime/src/resolve.rs) (1,036 lines) plus `resolve_tests.rs` | Original rewrite with no unavoidable engine or OS blocker to adopting already-compiled `bun_resolver`. Local code lacks `tsconfig.json` `paths`/`baseUrl` handling and does not clear its `package.json` cache on mutation. Keep only builtin, mock, and object-module hooks plus result translation. |
| Semver host functions | `bun_semver` algorithms plus unchanged [vendor/bun/src/semver_jsc/SemverObject.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/semver_jsc/SemverObject.rs) directly included by `bunwasm-semver` | `bunwasm-semver` (34), runtime `semver.rs` (41), `bunwasm-bun-jsc` (132), `bunwasm-bun-jsc-macros` (23) | Works cleanly because this slice only uses strings, booleans, 32-bit integers, and error messages over call-scoped slots. Keep this pattern for scalar/string host modules without mistaking it for general JSC emulation. |
| Glob | `bun_glob::match` and `BunGlobWalker` directly in [crates/bunwasm-runtime/src/glob.rs](../crates/bunwasm-runtime/src/glob.rs) (upstream 8,950 lines) | Rust wrapper (53 lines), JS `glob.ts` (46), `node_fs.js` options | Already upstream with a thin wrapper. Keep as-is. |
| Dotenv and `util.parseEnv` | `bun_dotenv::Loader` directly in [crates/bunwasm-runtime/src/parse_env.rs](../crates/bunwasm-runtime/src/parse_env.rs) (upstream 1,775 lines) | Rust file 79 lines (27 before tests) plus JS coercion | Parser is already upstream. Keep CLI env-loading policy aligned with upstream separately. |
| JSON, JSONC, JSON5, TOML, YAML | `bun_parsers` directly in [crates/bunwasm-transpiler/src/data.rs](../crates/bunwasm-transpiler/src/data.rs) (upstream 19,613 lines) | `data.rs` translates Bun AST to an identity-preserving tagged graph; `formats.ts` (299) and `formats_limit.ts` (11) reconstruct JS values | Shared/cyclic YAML references, lone surrogates, and Temporal conversion sit at the engine boundary. Keep portable graph plumbing and upstream parsers. |
| `node:path` | Windows routines call `bun_node_path` directly in [crates/bunwasm-runtime/src/node_path.rs](../crates/bunwasm-runtime/src/node_path.rs); build generates Windows `resolve`/`relative` from upstream [vendor/bun/src/node_path/lib.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/node_path/lib.rs) | `node_path.rs` (188) and `js/path.ts` (494), where POSIX routines are a hand port of upstream Rust/Node logic | POSIX stays in JS today to avoid repeated JS-to-Wasm crossings and own guest `cwd`. Do not label all of `node:path` as direct upstream; upstream [src/js/node/path.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/node/path.ts) wraps C++ `Path.cpp`. Only replace the JS fast path after measuring bridge overhead. |
| `Bun.color` | `bun_css::CssColor` parser and formatters in [crates/bunwasm-build/src/color.rs](../crates/bunwasm-build/src/color.rs) | `color.rs` (348 lines), adapted from [vendor/bun/src/css_jsc/color_js.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/css_jsc/color_js.rs), plus JS coercion | Core CSS parser is upstream; upstream's host layer binds directly to JSC `CallFrame` and `JSValue`. Share format/error helpers through data-only functions when upstream separates them. |
| `Bun.markdown` | `bun_md::root::{render_to_html_with_options,render_to_ansi}` in [crates/bunwasm-build/src/markdown.rs](../crates/bunwasm-build/src/markdown.rs) | Rust wrapper (64) plus `js/bun_markdown.ts` | HTML and ANSI rendering are already thin over upstream. `render`/`react` stay unsupported until a callback-capable value bridge exists. |
| Lint, fmt, check | Direct `bun_lint_driver`, `bun_sema_driver`, and direct `#[path]` inclusion of upstream `runtime/cli/typescript_libs.rs` | [crates/bunwasm-tools/src/](../crates/bunwasm-tools/src/): `lint_command.rs` (362), `check_command.rs` (443), `configuration_process.rs` (454), `main.rs` (41); crate total 1,985 lines | Lint and fmt already use upstream option parsers; `check` flags are parsed manually. Keep `bun-tools.wasm` lazy. Replace hardcoded `run_git` `NotFound` and single-thread `threads=1` limits after Waffle process and thread ABI wiring. |
| Lint native regex and normalization | Build extracts upstream `RegularExpression.cpp`, `NumberConversions.cpp`, and WebKit Yarr sources without pulling full JSC | `bunwasm-lint-native`: `build.rs` (202), `lib.rs` (19), `normalize.rs` (140, ICU4X adapter) | Good size boundary: rules get Yarr regex and Unicode normalization without a JS VM or 8.1 MB of ICU data. JS lint plugins still need Bun-specific AST/scope objects. |
| Parser C ABI, allocator, and string kernels | Most of [crates/bunwasm-glue/src/bun_native.rs](../crates/bunwasm-glue/src/bun_native.rs) is copied from Bun [src/sema/standalone/native.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/sema/standalone/native.rs) | `bunwasm-glue/src` (1,952 lines): `bun_native.rs` (1,236), `bundler.rs` (266), `extra.rs` (256), `native_host.rs` (167), `lib.rs` (27) | Copying a 1,236-line standalone shim drifts from upstream (`+204/-69` lines relative to source, including allocator changes). Prefer direct source inclusion with narrow override hooks while preserving the no-JSC compiler boundary. |
| POSIX fallback layer | Upstream `bun_sys`, `bun_paths`, and patched `third_party/libc` | [crates/bunwasm-posix/src/](../crates/bunwasm-posix/src/) (659 lines): `process.rs` (321), `fdpath.rs` (215), `mman.rs` (89), `lib.rs` (34) | Fallbacks predate Waffle's OS capabilities and now hide silent fake-success stubs at the OS boundary. Wire real Waffle providers and verify symbol ownership before adding upstream callers. |

### 2.3 Node, Bun, and Web APIs

| Subsystem | Upstream contribution today | Local code and size | Blocker and cutover direction |
| --- | --- | --- | --- |
| Builtin generation and loading | **G**: 23 selected factories from [vendor/bun/src/js](https://github.com/oven-sh/bun/tree/a7733435cf40429e3b35c36072769df2052b80f1/src/js) via upstream `bundle-modules.ts` | **A**: [scripts/generate-bun-builtins.mjs](../scripts/generate-bun-builtins.mjs) (~171), [scripts/bun-builtins.json](../scripts/bun-builtins.json), `js/bun_builtins.ts` (142), `bun_builtin_globals.ts`, `bun_provided_internals.ts`, `modules.rs` | Loader can embed far more upstream JS without native JSC. Today only `createNodeFetchInternalBinding` and `createUndiciInternalBinding` exist; other native hooks throw. Expand module by module along closed dependency and hook graphs. |
| `querystring`, `punycode`, `node:wasi`, fetch builtins | **G**: `172.js`, `171.js`, `192.js`, `196`–`199.js`, plus internal `fixed_queue`, `freelist`, `duplexpair`, `fast-utf8-stream`, and `stream/iter` | **A**: intrinsic adapter, two binding objects, local internal validators/stream dependencies | Keep this pipeline. `stream/iter` stays feature-gated. |
| `node:events` | **P**: adapted Node/Bun listener algorithms | [crates/bunwasm-runtime/src/js/events.ts](../crates/bunwasm-runtime/src/js/events.ts) (711) plus `event_emitter_async_resource.ts` | Upstream [vendor/bun/src/js/node/events.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/node/events.ts) needs 2 native hooks (`EventTarget` listener enumeration/count), Promise intrinsics, and internal validators. Replace local code with the generated upstream module once those hooks are wired. |
| `assert`, `util`, `inspect`, `console` | **P**: adapted Bun assertions, Node `parse_args`/comparisons, translated `ConsoleObject`/`VirtualMachine` inspect behavior | `assert.ts` (847), `util.ts` (1,811), `inspect.js` (4,286), `bun_console_constructor.js` (553); 9 files totaling ~8,716 lines / 353 KB | Native promise state, proxy target, heap inspection, and diff hooks are engine capabilities, not OS gaps. Adopt generated upstream JS first and keep missing browser introspection explicit. |
| `node:buffer`, `string_decoder`, encoding | **P**: Buffer helpers and translated `StringDecoder` state | `buffer.js` (1,337), `string_decoder.ts` (248), `encoding.rs` | Upstream `node:buffer` and `string_decoder` are native JSC modules. Keep typed-array/encoding adapters and reuse separable JS validation where possible. |
| `node:path` | **D**: `bun_node_path` and generated relative-path routines; **P/A**: JS shape | `js/path.ts` (494), `node_path.rs` (188), build-generated `node_path_relative.rs` | Windows paths reuse upstream; POSIX stays a maintained TypeScript port for JS-to-Wasm call cost. Measure before moving POSIX across the boundary. |
| `node:fs`, promises, watchers | **A/P** public wrappers; **D** lower Bun sys/path utilities and WASI I/O | `node_fs.js` (1,268) plus 9 `fs_*.ts` files (3,981 JS/TS lines / 173 KB); shared [crates/bunwasm-runtime/src/natives.rs](../crates/bunwasm-runtime/src/natives.rs) (3,373 lines, not all FS), `directory.rs`, `natives/*` | Upstream [vendor/bun/src/js/node/fs.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/node/fs.ts) delegates to `$rust("node_fs_binding.rs", "createBinding")`. Keep the Waffle syscall adapter and move public JS modules onto generated upstream once the binding contract is wired. |
| `process`, `child_process`, signals, pipes | **A/P** | `process.ts` (630), `spawn.ts` (1,275), 11 helper files (2,910 lines / 137 KB), `host.rs`, `bunwasm-host/src/process/*` | Upstream [vendor/bun/src/js/node/child_process.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/node/child_process.ts) is a generated wrapper over `Bun.spawn`. Keep Waffle process admission, pipes, and signals; replace duplicated public JS wrappers once streams and error constants align. |
| `node:worker_threads`, Web Workers, clone | **A** routing, structured clone, transfer ownership, `MessagePort`, `BroadcastChannel` | `worker_threads.ts` (1,688), `worker_codec.ts` (484), `worker_channel.ts`, `worker_lane.ts`, `worker_stdio.ts`, `structured_clone.ts`, `web_worker.ts` (3,010 lines / 168 KB excluding `.d.ts`) | Upstream [vendor/bun/src/js/node/worker_threads.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/node/worker_threads.ts) consumes a 17-element binding tuple from `Worker.cpp`. Keep the host Web Worker boundary and migrate the JS wrapper to that binding contract. WASI M1 threads do not eliminate isolated JS realms or port ownership. |
| Web globals (`Blob`, `Request`, `Response`, `Headers`, `URL`, `FormData`, `performance`) | **A/P**; reuses host `DOMException` and stream constructors where supplied; URL uses crates.io `url` | `web.js` (1,818) plus 9 body/URL/text helpers (2,823 lines / 118 KB) | Upstream implementations live in WebCore/JSC. Keep browser-native objects where the contract permits and name any Bun extensions that need thin wrappers. |
| `node:stream` and Web Streams | External `readable-stream` 4.7.0 (Node 18.19 base) with hand-maintained substitutions; **G** Bun `duplexPair`, `stream/iter`, fast UTF-8 subset | `node_stream_core.js` (86,537 bytes minified), `node_stream_web.js` (508 lines), [scripts/vendor-node-streams.mjs](../scripts/vendor-node-streams.mjs), `node_stream_bindings.ts`, `streams_polyfill.js` (61,312 bytes for guest engines) | Separate upstream lineage from Bun. Replace the whole connected Node stream family together so constructor identity never splits; keep Web Streams native on the browser host. This unlocks upstream `fs`, `http`, `child_process`, and `ws`. |
| `Bun.serve`, `node:http`/`https`, `Bun.connect`/`listen`, `node:net`, `fetch` | **A/P** protocol and API wrappers; **D** Waffle network host | `net.js` (1,957), `node_net.js` (379), `bun_tcp.ts`, `http_*`, `net_*`, `fetch_*`, `serve_*`, TLS helpers (30 files, 6,077 lines / 291 KB); [web/src/net/host.ts](../web/src/net/host.ts) (~150) | Upstream server and fetch couple to `bun_uws`, `bun_http`, and JSC objects. Keep browser `fetch()` for ordinary HTTP and Waffle for loopback/relay; target generated `node:http`/`node:net` JS and extracted server policy over time. |
| Unix sockets | **A** consumer over Waffle `listenPath`/`connectPath` | `net_path.ts`, host slots 16/17, `web/src/net/host.ts`, launcher path-scope leases | Kernel blocker is retired in Waffle. Keep browser and native Wasmtime host capabilities documented separately. |
| `WebSocket` and `ws` builtin | **A** global transport; external `ws` 8.18.3 bundled via [scripts/generate-ws.sh](../scripts/generate-ws.sh) | `websocket.ts` (462), `ws_builtin.js` (2,882 lines / 94,189 bytes) | Upstream [vendor/bun/src/js/thirdparty/ws.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/thirdparty/ws.ts) needs 3 native hooks. Adopt generated Bun `ws` once stream and upgrade bindings are ready. |
| `node:tls`, X509, raw TLS | **A** TLS driver over real BoringSSL; **P** identity and option checks | `tls.rs` + 7 non-test files (2,725 lines / 85 KB), `node_tls.ts` (335), `tls_connection.ts` (333), `x509*.rs`, `bunwasm-crypto-sys/src/tls.rs` | Keep the memory-BIO adapter for raw TLS traffic such as database drivers. Ordinary HTTPS fetch stays on browser `fetch()`. Revisit BoringSSL's no-thread build flag before sharing it across WASI threads. |
| WebCrypto and `node:crypto` | **A/P** public records over RustCrypto, BoringSSL, and host WebCrypto async acceleration | 10 JS/TS files (3,399 lines / 172 KB) plus `builtins.js` crypto section; 9 Rust files (4,552 lines / 152 KB); `bunwasm-crypto-sys` | Align BoringSSL pins, reuse byte-oriented upstream crypto crates first, and keep host SubtleCrypto acceleration behind a compute trait. Sync Node APIs must remain synchronous. `scrypt`/`scryptSync` stay unsupported until implemented. |
| Hashing and `Bun.hash` | **D** `bun_wyhash`; **P** copies of Bun cityhash, murmur, rapidhash; `xxhash-rust` instead of Highway | `crates/bunwasm-runtime/src/bun_hash/{cityhash,murmur,rapidhash,mod}.rs`, `bun.js` wrappers | [vendor/bun/src/hash/Cargo.toml](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/hash/Cargo.toml) depends only on `bun_highway`. Source-select exact vendored hash leaves directly and delete local copies. Replace chunk-accumulating `Hash`/`CryptoHasher` buffers with incremental streaming contexts. |
| `Bun.CSRF` | **P** port of pure byte-oriented [vendor/bun/src/csrf/lib.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/csrf/lib.rs) | `csrf.rs` (323), `js/bun_csrf.ts` (94) | No JSC in core. Direct-crate candidate once BoringSSL pin, allocator initialization, and entropy handling are aligned. |
| `Bun.password` | **D** vendored `rust-argon2` and `bcrypt`; **P** API and hash policy | `password.rs` (351), `js/bun_password.ts` (113) | Upstream [vendor/bun/src/runtime/crypto/pwhash.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/runtime/crypto/pwhash.rs) is mostly pure policy. Extract and reuse it while keeping allocation budgets and async dispatch. |
| `node:zlib`, gzip/zstd, `CompressionStream` | **D** `bun_brotli_sys`, `bun_zstd`, vendored Brotli 1.2.0 and zlib-ng 2.3.3; **P** state machines and JS API | `compression.rs` (1,916), `js/zlib.ts` (775), `zlib_ffi.rs`, `streams.rs`, `compression_streams.ts` (3,278 lines / 133 KB) | Extract upstream `NativeZlib`/`Brotli`/`Zstd` context cores from `bun_runtime` wrappers while keeping bounded 1 MiB chunking and portable fallbacks. |
| `Bun.Archive` | **A** wrapper over `tar` + `flate2` | `archive.rs` (372), `js/archive.ts` (80) | Share upstream [vendor/bun/src/libarchive](https://github.com/oven-sh/bun/tree/a7733435cf40429e3b35c36072769df2052b80f1/src/libarchive) via the installer archive work; keep the Blob/value adapter. |
| `bun:sqlite` | **D** unmodified SQLite from `libsqlite3-sys`; **P** Bun JS `Database`/`Statement`; **A** numeric handle FFI | `js/bun_sqlite.ts` (604), `sqlite.rs` (983) | Implement the narrow `createJSSQLStatementConstructor` binding over the existing handle registry to use generated upstream JS. Move off `unix-none` onto real `fcntl` locking with concurrency tests; evaluate WAL separately. |
| `HTMLRewriter` | **D** `vendor/bun/vendor/lolhtml` | `html_rewriter.rs` (318), `js/html_rewriter.ts` (265) | Appropriate library reuse plus engine suspension adapter. |
| `Bun.markdown`, `Bun.color` | **D** `bun_md`, `bun_css` through `bunwasm-build`; **P** option parsing | `js/bun_markdown.ts` (84), `js/bun_color.ts` (95) | Core parsers are upstream; callback-dependent `markdown.render`/`react` wait for a callback bridge. |
| `Cookie`/`CookieMap`, `ArrayBufferSink`, `Bun.file` | **P** translated C++/Rust behavior and lifetime adapters | `cookie.ts` (338), `array_buffer_sink.ts`, `bun.js` `BunFile`, `bun_file.ts` (108) | Keep host lifetime adapters and reuse independent upstream parsing where extractable. |
| `Bun.plugin` and `Bun.build` plugins | **A** minimal `plugin.module` object loader; `Bun.build` rejects nonempty plugins | `bun_plugin.ts` (40), `bun.js` | Do not grow a second plugin system. Wait for a callback/value bridge wired into upstream `BundleV2` plugin hooks. |
| `Intl` and `Temporal` | External FormatJS/ICU4X/Temporal polyfills; host uses native `Intl` | `intl.js` (1.29 MB), `tz_data.js` (1.36 MB), `temporal.js` (161,889 B) | `engine-host` builds already exclude `Intl`, time-zone, and stream polyfills. `temporal.js` stays embedded for browsers without native `Temporal` and evaluates lazily. Keep optional fallbacks out of the default browser build. |

### 2.4 Engine, module, event-loop, and host boundaries

| Subsystem | Upstream contribution today | Local code and approximate size | Blocker and intended ownership |
| --- | --- | --- | --- |
| `Engine` trait and data protocol | None upstream | [crates/bunwasm-runtime/src/engine.rs](../crates/bunwasm-runtime/src/engine.rs) (306), `data.rs` (278), `engine_host.rs` (559), `split.rs` (289), `split_api.rs` (18) | Real boundary to keep. The browser host codec covers strings, bytes, arrays, records, scalars, and 64-bit integers, not arbitrary rooted JS values. Extend semantic capabilities instead of emulating JSC bit layouts. |
| Browser native engine | Browser JIT, native `Intl`/`WebAssembly`/Web Streams, selected WebCrypto; Bun parser/printer supplies prepared source | [web/src/engine-host.js](../web/src/engine-host.js) (1,521), `module-records.ts` (308), evaluation/promise/scheduler/codec helpers | Default boundary to keep. Engine-private promise state, proxies, heap stats, and async context remain real host limits; host scheduling cannot synchronously drain browser Promise jobs. |
| CJS/ESM loader and source preparation | Upstream parser/printer and selected `runtime.js` helpers; printer patches emit registration data | `modules.rs` (1,549), `bootstrap.js` (1,707), `esm_loader.ts` (769), transpiler prep crates | Browser lacks JSC's native module-loader API, so an engine adapter stays necessary. Package resolution and JS module policy should still converge on upstream code. |
| Narrow `bun_jsc` facade | **S**: upstream `semver_jsc/SemverObject.rs` unchanged | `bunwasm-bun-jsc` (132), `bunwasm-bun-jsc-macros` (23), `bunwasm-semver` (34) | Proven pattern for scalar/string host modules. No persistent objects, class layouts, GC, promises, or callbacks. |
| Optional engines (`QuickJS`, `JSC`, `SpiderMonkey`, dormant `Hermes`) | Patched external engines; none reuse Bun's C++ JSC runtime bindings | `bunwasm-engine-quickjs` (5,064, includes shared driver), `bunwasm-engine-jsc` (1,031) + `bunwasm-jsc` (2,568), `bunwasm-engine-spidermonkey` (923) + `bunwasm-spidermonkey` (10,145); dormant `bunwasm-engine-hermes` (1,175) + `bunwasm-hermes` (1,539) | Keep optional and lazy-loaded. Extract shared embedding driver code out of the QuickJS crate into an engine-neutral package so each engine becomes a standalone Waffle package. Hermes remains dormant and rejected by shipping selectors. |
| Guest JS event loop and compiler mini loop | Compiler uses patched `bun_event_loop` / `bun_threading` with fake 16 KiB uWS loop and inline pool | `engine-quickjs/src/{program,driver}.rs`, JS scheduler/timers, `engine-host.js`, `bunwasm-glue/src/bundler.rs` | Keep a deliberate serial backend for light commands, and build a real poll/wake backend over Waffle for async upstream consumers such as `bun_install`. |
| Waffle package, network, FS, terminal integration | Real Waffle `Runtime`, `RuntimeNetHost`, `RuntimeNetHelper`, `SharedFilesystem`, terminal controls | `src/` (23 files, 1,749 lines), `web/src/` (130 files, 22,577 lines) | Legitimate browser integration. Keep executable admission, preview origin policy, caching, and host bridges here. |
| Native launcher | Wasmtime, WASI, native sockets/HTTP/TLS | `bunwasm-host` (42 files, 26,108 lines including tests) | Alternate host and conformance oracle; excluded from browser Wasm payloads. Keep one ABI contract and document host differences explicitly. |
| Nested WebAssembly | Patched `wasmi`/`wasmi_core` for guest engines; native `WebAssembly` in browser | `bunwasm-nested` (2,923), `wasm.rs`, `web/src/nested/*` | Optional guest-engine capability; keep excluded from `engine-host`. |

### 2.5 Unsupported or partial public APIs

Visible directly in [crates/bunwasm-runtime/src/js/builtins.js](../crates/bunwasm-runtime/src/js/builtins.js), [crates/bunwasm-runtime/src/js/bun.js](../crates/bunwasm-runtime/src/js/bun.js), and [crates/bunwasm-runtime/src/modules.rs](../crates/bunwasm-runtime/src/modules.rs):

| API | Current source behavior | Why Waffle alone does not complete it |
| --- | --- | --- |
| `node:vm` | `createContext` returns the original object; `isContext` accepts any object; evaluates via `with(context){eval}` | Needs an engine/host realm contract, not OS syscalls. |
| `node:v8` | Uses `bun-wasm:structured\0` plus a JSON worker codec; heap stats are simplified and flag setters are no-ops. Upstream [vendor/bun/src/js/node/v8.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/js/node/v8.ts) uses JSC serialized values, not the V8 wire format | Engine heap/serialization ABI cannot come from OS syscalls. State the parity target explicitly. |
| `node:cluster` | `fork`/`setup`/`disconnect` throw with a stale `NO_PROCESSES` error | Waffle supplies processes; needs cluster IPC, handle transfer, and upstream JS wiring. |
| `node:dgram`, `Bun.udpSocket` | Throw `NO_NETWORK` | Waffle supplies TCP/Unix/loopback, not UDP. Needs a real datagram capability. |
| `node:http2` | Server/client constructors throw; `Http2ServerRequest`/`Response` are compatibility shims | Needs an HTTP/2 protocol stack and bindings, not just TCP. |
| `node:tty` | `isatty` works; `ReadStream`/`WriteStream` throw "no terminal streams" | Waffle PTY exists (`waffle#673`); wire upstream `TTYWrap` bindings, raw mode, and resize hooks. |
| `Bun.Terminal` | Not exposed on `Bun`; `web/src/bun-terminal.ts` only attaches host terminals | Waffle PTY exists; expose the public class over Waffle PTY handles. |
| `node:inspector` | `open`/`waitForDebugger`/`Session` throw; `close` is a no-op | Requires engine debugging hooks, not OS syscalls. |
| `node:perf_hooks` | `PerformanceObserver` is a no-op; histograms return zeros; `timerify` returns the original function | Needs host engine instrumentation or explicit capability errors. |
| `node:diagnostics_channel` | Ordinary `Channel` (`subscribe`, `unsubscribe`, `publish`, `hasSubscribers`) works; `bindStore`/`unbindStore`/`runStores` and `tracingChannel` methods (`subscribe`/`unsubscribe`/`traceSync`/`tracePromise`/`traceCallback`) are no-ops or pass-throughs | High-leverage Slice 2 cutover: upstream catalog entry has **zero native hooks** and only depends on `internal:validators`. |
| `node:async_hooks` | Adapted `AsyncLocalStorage` works; `createHook` is a no-op and async IDs stay constant | Needs engine async-resource hooks; keep working ALS without faking full hook coverage. |
| `node:domain`, `node:trace_events` | Explicit unsupported stubs | Low priority / deliberate unavailability contract. |
| `bun:ffi`, N-API `.node` addons | Methods throw; `process.dlopen` throws | Native machine-code `.so`/`.node` binaries cannot run as Wasm; requires a WASI/host extension ABI and compiled WASI packages. |
| `Bun.SQL`, `bun:sql`, Redis, S3, `FileSystemRouter`, `node:sqlite` | Not registered in the local public registry | Need native bindings and transport adapters in later milestones. |
| `Bun.openInEditor` | Throws stale "WASI has no processes" | Needs a browser editor-open host hook, not a native child process. |
| `Bun.unsafe.arrayBufferToString`, `Bun.markdown.render`/`react` | Explicit throws | Need engine zero-copy string or per-node callback capabilities. |

## 3. Installer cutover assessment

### 3.1 What to replace

[crates/bunwasm-runtime/src/install/](../crates/bunwasm-runtime/src/install/) owns package-manager policy, not just transport: manifest editing, recursive graph resolution, version and peer selection, overrides, workspace discovery, workspace `catalog:` resolution (added in `#1108` via `catalog.rs` and `catalog_tests.rs`), hoisting, lockfile generation and migration, extraction, pruning, bin linking, and `bunx` preparation. Direct upstream reuse there is limited to semver, glob, and data parsers. Its graph caps depth at 128 and packages at 10,000, supports only the hoisted linker, lacks `.npmrc` and scoped registry auth, skips lifecycle scripts (making `--ignore-scripts` a no-op), and rejects archive symlinks in `install/io.rs`.

The `#1108` merge added 7,270 lines across the custom installer, tests, and browser fetch/cache layer to support `catalog:` protocols, actionable fetch errors, and `rewritePackageUrl`. That growth confirms why continuing to expand the local installer is expensive: every npm/pnpm/yarn feature gets reimplemented twice. Transport features from `#1108` (package URL rewriting, per-hop redirect error reporting, browser cache scoping) belong in the host transport adapter below upstream `bun_install`, while graph, catalog, override, migration, hoisting, and lockfile policy should move to upstream [vendor/bun/src/install](https://github.com/oven-sh/bun/tree/a7733435cf40429e3b35c36072769df2052b80f1/src/install) (95 Rust files, 106,906 lines).

### 3.2 Concrete upstream `bun_install` dependencies and gates

A manifest traversal of normal, build, and optional dependencies across all target branches visits **76 known in-tree packages** (excluding dev dependencies) and finds no `bun_jsc`, `bun_runtime`, or `bun_bindgen` in `bun_install`'s closure (`bun_jsc_macros` enters via `bun_uws` as a proc-macro crate). That proves Cargo engine independence, not yet wasm32 link independence or small binary size.

Concrete integration points in [vendor/bun/src/install/Cargo.toml](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/install/Cargo.toml) and its modules:

- **HTTP and DNS:** `NetworkTask.rs` embeds `AsyncHTTP<'static>`, signal stores, and HTTP-thread callbacks; `PackageManager.rs` starts `http_thread::init`; `install_with_manager.rs` prefetches DNS directly. Replace HTTP transport behind a clean backend boundary using browser `fetch()`, omitting guest DNS prefetch and guest TLS for ordinary registry HTTP.
- **Archive extraction and integrity:** `extract_tarball.rs` and `TarballStream.rs` use `bun_libarchive::Archiver`, optional `libdeflate`, and resumable C read callbacks; `integrity.rs` hashes compressed tarball bytes incrementally via `bun_sha_hmac`; `lockfile.rs:2167` calls `bun_boringssl_sys::rand_bytes`. Preserve raw compressed `.tgz` bytes for SRI verification distinct from HTTP `Content-Encoding`.
- **Event loop and timers:** `PackageManager.rs` owns `ThreadPool` and parents onto `MiniEventLoop` (which dereferences a uWS loop); `retry_timer.rs` spawns a helper thread. The compiler's fake 16 KiB uWS loop and no-op `tick`/`wake` cannot run async installs; wire a real Waffle poll/wake loop.
- **Lifecycle scripts and upward linker callbacks:** `lifecycle_script_runner.rs` uses `bun_io::BufferedReader` and `bun_spawn::Process`, and selects Windows pipes under `cfg(not(unix))` (`lifecycle_script_runner.rs:703`); `bun_spawn/lib.rs:94` only exports `unix`/`windows` aliases, and `bun_spawn/lib.rs:49` defines `ProcessExit` handlers owned by both `install` and `runtime`. Add explicit WASI backend arms and feature-gate or fail-fast unreachable runtime-owned variants.
- **Pointer-width and disk-format gates:** `install/lib.rs:1047` asserts `TaskCallbackContext` is 32 bytes; `padding_checker.rs:102` restricts disk-layout checks to 64-bit little-endian; `lockfile.rs:2086` writes a native-width `usize` total-size field. Qualify each layout and use fixed-width serialization (or stage text `bun.lock` first) rather than silencing layout checks.

### 3.3 Backend interfaces for lazy `bun-pm.wasm`

| Boundary | Upstream policy kept | Browser / Waffle adapter role | Acceptance check |
| --- | --- | --- | --- |
| Registry transport | Registry/auth scope selection, retries, metadata parsing, resolution | Browser `fetch()`, URL rewriting (`rewritePackageUrl`), cancellation, bounded streaming, actionable errors | Controlled registry fixtures, redirects, auth, failures, cancellation, concurrent fetches; no guest TLS/DNS for HTTP registries |
| Archive reader/extractor | Integrity verification, cache staging/publication, links, install transactions | Selective WASI `libarchive` build or contract-compatible thin archive backend | Long paths, symlinks, permissions, truncation, corrupt archives, deterministic publication, compressed-byte SRI |
| Task/timer/loop backend | Pending work ownership, completion order, retries, cancellation | Real Waffle wait/poll/wake, bounded cooperative scheduling (and/or qualified M1 workers) | Progress and cancellation under concurrent fetch and extract tasks; no lost wakes |
| Process backend | Trusted-script selection, pre/main/post order, env and npm command rewrites, exit reporting | Waffle executable admission, `cwd`/`env`, stdio, spawn/wait/signal/PTY mapping | Workspace lifecycle scripts, generated outputs, signals, inherited fds, failed-install cleanup |
| Filesystem and cache | Upstream cache layout and hoisted/isolated link policy | Real `flock`/`fcntl` locks, atomic rename, fd/path translation, batched transport | Two concurrent installers, cross-tab locking, killed owner recovery, cache reuse, symlinks, OPFS persistence |
| Crypto and entropy | Upstream integrity and signing semantics | Reconcile BoringSSL pin/ABI or narrow digest/RNG backend; keep incremental state | Upstream integrity vectors and large streamed archives |

Build an on-demand `bun-pm.wasm` around upstream `CommandLineArguments::parse`, `PackageManager::init`, and `install_with_manager` (matching `runtime/cli/install_command.rs` without linking `bun_runtime`). Stage lockfile-only resolution first, then extraction/publication, then trusted lifecycle scripts, and delete the local `install/` reimplementation once parity passes.

### 3.4 Platform package substitutions as an explicit manifest

The current resolver hardcodes WASM substitutions for `esbuild`, `lightningcss`, `rollup`, Next.js SWC WASM injection, and `rolldown`/`emnapi` version rewrites inside graph traversal ([install/resolve.rs](../crates/bunwasm-runtime/src/install/resolve.rs), `resolve/next_swc.rs`, `resolve/wasm_packages.rs`). Move those substitutions out of solver logic into a declared platform-distribution manifest recording original package/version, substituted WASM package/version, integrity, and compatibility evidence. Let upstream own graph resolution.

## 4. Waffle blocker reassessment

| Waffle capability | Prior blocker status | Work still needed inside `bun-wasm` |
| --- | --- | --- |
| Memory, IndexedDB, OPFS, multi-tab VFS | Kernel gap retired | Guest fd/error contracts, atomic publication, symlink metadata, cross-tab cache invalidation |
| `flock`/`fcntl` (`waffle#670`) | Kernel gap retired | Remove fake-success `flock` from live paths, map lock commands/lifetimes, migrate `bun:sqlite` off `unix-none` with concurrency tests |
| Processes, pipes, signals | Kernel gap retired | Replace `posix_spawn`/`socketpair`/PID/signal stubs in `bunwasm-posix`, wire upstream lifecycle scripts and `--filter` runner |
| `AF_UNIX` | Available and wired in browser net host | Native `bun_io` event-loop integration, `socketpair` vs path-socket contracts, native launcher parity |
| PTY (`waffle#673`) | Kernel gap retired | Expose `Bun.Terminal` and `node:tty` `ReadStream`/`WriteStream` with raw mode, resize, and descriptor lifecycle |
| `/etc/machine-id` (`waffle#672`) | No installer blocker | Read VFS identity directly; do not add a separate identity layer |
| WASI threads M1 | Thread creation available | Qualify Rust target ABI, TLS, allocator, futex, cancellation, real wake/poll, VM confinement, and thread-safe BoringSSL together |
| Loopback networking | Available | Separate protocol capabilities for HTTP/2, UDP, raw TLS, DNS, and external relays |

None of these kernel capabilities provides a JSC heap, 64-bit tagged values, browser engine-private promise/proxy introspection, or a native machine-code `.node` loader. Equally, those engine limits never justify rewriting JSC-free installation or resolution algorithms.

## 5. Engine and builtin cutover assessment

### 5.1 The concrete JSC blocker

Upstream [vendor/bun/src/jsc/JSValue.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/jsc/JSValue.rs) defines `JSValue` over `usize` and asserts `size_of::<JSValue>() == size_of::<i64>()`. That fails directly on `wasm32`, and its methods inspect JSC cells and invoke C++ exports. `bun_runtime` embeds generated class/sink bindings across JSC, uWS, crypto, archive, and SQL. The checked lexical inventory ([docs/bun-jsc-inventory.json](bun-jsc-inventory.json)) spans 470 Rust files in upstream `src/runtime` (299 with JSC references, 16,242 lexical references; 555 files / 362 users / 17,639 references including sibling crates).

### 5.2 Highest-leverage reuse path

1. **Expand generated upstream JS modules** in closed dependency groups: `node:diagnostics_channel` first (0 native hooks), then shared validators, errors, `node:events`, utilities, and the connected Node stream family.
2. **Implement exact named binding contracts** for SQLite, filesystem, child processes, workers, and TTY over existing handle registries and Waffle services while keeping one consistent stream/Buffer/error constructor lineage.
3. **Source-select byte/data cores** (`print_diff`, hashes, CSRF, `pwhash`, compression contexts, archive cores) via direct `#[path]` inclusion or narrow upstream feature hooks instead of maintaining edited copies.
4. **Add a rooted-value host ABI** (realm-scoped handles, explicit rooting/release, lone-surrogate strings, `BigInt`, symbols, exceptions, reentrant callbacks, buffer detach, native classes, async settlement) for remaining API cores while keeping the plain-data fast path for bulk calls.
5. **Align native crypto pins** before sharing `bun_sha_hmac` or `bun_csrf`: [scripts/sync-crypto.sh](../scripts/sync-crypto.sh) pins BoringSSL `41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`, whereas upstream [vendor/bun/scripts/build/deps/boringssl.ts](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/scripts/build/deps/boringssl.ts) pins `fe703e9faa3bfd22b04eb192066856557b7e015c`. Pure hash leaves (Adler, City, Murmur, Rapid) do not depend on BoringSSL alignment.

### 5.3 Optional engines: split, not yet standalone

[src/bun-adapter.ts](../src/bun-adapter.ts) defaults to `browser` and loads optional engine programs lazily. However, `crates/bunwasm-engine-quickjs/src/side_modules.rs` and `driver.rs` import Bun-specific runtime codecs, loader callbacks, and `bun_core_*` services, and the JSC and SpiderMonkey crates include that shared driver from the QuickJS crate. Moving the engine embedding contract into independent Waffle packages with one versioned engine-host interface keeps Bun glue in a separate adapter without giving up shared-memory linking.

## 6. Architectural drift and deletion targets

| Priority | Source-backed finding | Action |
| --- | --- | --- |
| P0 | `bun run --filter` and workspace flags entered `exec_argv` without executing any selector or DAG | Reject unimplemented scope-changing flags explicitly in Slice 1; wire upstream `workspace_selection`/`filter_run`/`multi_run` in Slice 4. |
| P0 | `crates/bunwasm-runtime/src/natives.rs:open_file` rejected `O_NONBLOCK` (`2048`), breaking `@tailwindcss/oxide-wasm32-wasi` directory scans (`wasi-libc` `opendir`) | Add `2048` (`libc::O_NONBLOCK`) to `open_file` with `fs.openSync` and `node:wasi` regression tests in Slice 1. |
| P0 | `crates/bunwasm-build/src/stubs.rs:201` declared `__bun_resolver_init_package_manager` with 4 params and `SystemErrno`, while upstream declares 5 params (`importer_dir: &[u8]`) and `bun_resolver::Error` | Repair exact ABI signature in Slice 1 before linking or enabling auto-install. |
| P0 | `crates/bunwasm-posix/src/process.rs` has fake-success `flock`, `ENOSYS` spawn/`socketpair`, fixed PIDs, ignored signals, and process-exiting `pthread_exit` | Wire real Waffle `flock`, spawn, signals, and PIDs in Slice 3; remove fake-success stubs. |
| P0 | `bun:sqlite` opens `unix-none` with WAL compiled out | Migrate `bun:sqlite` onto real `fcntl` locking with concurrency tests in Slice 3. |
| P0 | `install/mod.rs` skips lifecycle scripts and makes `--ignore-scripts` a no-op | Restore upstream trusted lifecycle runner over Waffle spawn in Slice 4. |
| P1 | Separate 1,036-line runtime resolver (`resolve.rs`) lacks `tsconfig` `paths`/`baseUrl` and does not clear its `package.json` cache on mutation | Replace with already-compiled `bun_resolver` (`prefer_module_field=false`) with cache invalidation in Slice 2. |
| P1 | Patched Bun `ThreadPool`/`Futex` force serial WASI, fake `MiniLoop`, and single-threaded BoringSSL | Keep deliberate serial fallback; qualify M1 threads, real wake/poll, allocator, and thread-safe crypto together before enabling concurrency. |
| P1 | Generated catalog lists 214 modules / 332 hooks, while only 23 factories are embedded | Track active factory and hook closures separately from discovery catalog counts. |
| P1 | BoringSSL pin mismatch between `sync-crypto.sh` and upstream Bun 1.4.5 | Reconcile archive/binding ABI before sharing `bun_sha_hmac`/`bun_csrf`. |
| P1 | Hardcoded WASM package substitutions inside installer graph traversal | Extract to an explicit platform-distribution manifest in Slice 4. |
| P1 | Adapted Bake finalization misses upstream JS/CSS print-error recording | Source-share finalization through a driver context. |
| P2 | `crates/bunwasm-glue/src/bun_native.rs` (1,236 lines) copied from upstream standalone shim (`+204/-69`) | Direct-select upstream support source with narrow override hooks. |
| P2 | `print_diff.rs` is byte-identical to upstream, while colorless diff uses a duplicate JS LCS path | Source-select upstream `printDiff.rs` and route both color modes through it in Slice 2. |
| P2 | External `readable-stream` 4.7.0 and `ws` 8.18.3 lineages separate from Bun | Replace with generated Bun stream and `ws` modules once binding contracts exist. |
| P2 | `Hash`/`CryptoHasher` accumulate input chunks and concatenate at digest | Replace with incremental streaming contexts. |
| P2 | Rust `tool_args.rs` and TS `tool-command.ts` both encode CLI arity | Generate shared flag metadata and keep browser pre-dispatch minimal. |
| P2 | Native registrations for SQLite, TLS, crypto, archive, compression, and HTMLRewriter are eager | Feature-scope heavy services at explicit load boundaries. |
| P2 | Stale `NO_PROCESSES`/`NO_NETWORK` messages, old default-engine ADR, outdated lockfile and terminal docs | Refresh capability diagnostics and docs from actual runtime routes. |
| P2 | Dormant Hermes crates remain in workspace; shared engine driver lives in QuickJS crate | Keep Hermes documented as dormant; move shared embedding code into an engine-neutral crate. |

## 7. Phased cutover plan

| Slice | Scope | Exit gate | Cold-start and Wasm size guard |
| --- | --- | --- | --- |
| Slice 1: Contracts, docs, and P0 fixes | Commit `docs/upstream-vs-ours.md` and link it across repo docs; state upstream-first rule in `AGENTS.md` and `docs/concepts/architecture.md`; fix `O_NONBLOCK` (`2048`) in `open_file`; fix 4-vs-5-arg `__bun_resolver_init_package_manager` ABI; reject unimplemented `bun run --filter`/workspace flags explicitly; enable `oxlint` never-nester and `unknot` CI gate on `src/` + `web/` | Rust unit tests, WASI Clippy, fixture tests across engines, `quality --javascript` (`lint`, `types`, `unused`, `duplicates`, `structure`, `probes`) all green | Zero new runtime dependencies or browser guest growth |
| Slice 2: Delete low-risk forks | Replace `crates/bunwasm-runtime/src/resolve.rs` (1,036 lines) with compiled upstream `bun_resolver` (`prefer_module_field=false`, preserving builtin/mock hooks, adding `tsconfig` `paths`/`baseUrl` and `package.json` cache invalidation); wire generated upstream `node:diagnostics_channel` (0 native hooks); source-select exact `print_diff` and hash leaves | Resolution matches pinned native Bun across exports/imports, aliases, `tsconfig` paths, symlinks, and file mutations; `diagnostics_channel` and diff/hash tests pass | `bun_resolver` is already in the compiler closure; measure newly reachable functions and syscall counts |
| Slice 3: Real OS providers | Wire real Waffle `flock`, spawn, signals, and PIDs in `bunwasm-posix/src/process.rs` (deleting fake-success stubs); migrate `bun:sqlite` off `unix-none` onto real `fcntl` locking with concurrency tests; wire `Bun.Terminal` and `node:tty` over Waffle PTY (`waffle#673`) | Cross-process/cross-tab lock tests, owner death, fd inheritance, PTY raw mode and resize, signals, and concurrent SQLite tests pass | Keep threads lazy and bounded; no eager worker pool on hello-world |
| Slice 4: Upstream `bun_install` and `--filter` | Build lazy `bun-pm.wasm` around JSC-free `vendor/bun/src/install` behind browser `fetch()`, archive, Waffle poll/wake, and Waffle spawn seams; qualify wasm32 layouts and fixed-width lockfile serialization; move WASM package substitutions into an explicit manifest; delete custom `install/` after parity; wire upstream `workspace_selection.rs`/`filter_run.rs`/`multi_run.rs` monorepo runner | Lockfile-only, install/reinstall/frozen/offline, peers/overrides/catalogs/workspaces, extraction races, trusted lifecycle scripts, and `--filter` DAG fixtures pass against native Bun | Highest size risk: exclude native HTTP/TLS/DNS from `bun-pm.wasm`, load `bun-pm.wasm` only on PM commands, keep bounded parallel fetch/extract |
| Follow-up: Builtins, cores, standalone engines | Expand generated upstream JS builtins (validators, errors, `events`, connected `node:stream`, `fs`, `child_process`, `worker_threads`, `sqlite`); extract byte/data cores and rooted-value host ABI; extract QuickJS/JSC/SpiderMonkey into standalone Waffle engine packages | Upstream API family suites and independent Waffle engine consumption pass | Keep browser native JIT default and heavy optional services lazy |

## 8. Browser speed and size gates

The `browser` guest (`engine-host`) already excludes Wasmi, `Intl`, time-zone, and stream polyfill payloads. Keep those exclusions and enforce these boundaries during every cutover slice:

| Boundary | Keep and improve | Avoid |
| --- | --- | --- |
| JS engine | Browser native JIT default; optional engines selected and fetched on demand | Shipping JSC, QuickJS, SpiderMonkey, or their `Intl` fallbacks in the default browser guest |
| PM, tools, tests | Separate lazy command binaries (`bun-pm.wasm`, `bun-tools.wasm`) with content-addressed caching | Linking installer transport or test runner code into first-eval startup |
| Fetch | Browser `fetch()` for ordinary HTTP and Waffle loopback/relay routing | Using guest TLS/DNS for ordinary HTTP or conflating HTTP `Content-Encoding` with `.tgz` bytes |
| Crypto | Host SubtleCrypto for eligible async bulk work; incremental portable state for sync calls | Turning sync Node crypto APIs async or buffering entire hash inputs in JS |
| Compression and archives | Browser-native decoding where contracts match; portable fallback for sync/flush/dictionary options with bounded chunks | Buffering whole compressed and inflated archives without a memory cap |
| Filesystem | Batched syscall/message transport, persistent cache keys, generation-based invalidation | Keeping a custom resolver or solver solely to cut crossings, or serving stale `package.json` caches across tabs |
| Linking | Feature-scoped dependencies, lazy registration, one provider per symbol | Relying on dead-code stripping to hide ABI mismatches or eagerly registered services |

Measure every cutover with matched inputs: transferred Brotli/gzip bytes, decoded Wasm bytes, JS bundle bytes, compile/instantiate time, worker count, time to first output, first TS module, install graph/extract time, peak linear memory, and syscall crossings on hot paths. Separate cold and warmed caches.

## 9. Acceptance for real apps and monorepos

A cutover milestone is complete only when unmodified real repositories and monorepos run end-to-end at pinned revisions, with every platform-distribution substitution recorded:

- **Install fidelity:** workspace, `link:`, `file:`, `npm:` alias, `catalog:`, registry, tarball, and git dependencies; peer, optional, dev, and platform filters; overrides; `.npmrc` and scoped auth; native `bun.lock` read/write/frozen/no-op reinstall; hoisted and isolated placement; bin links; trusted lifecycle scripts.
- **Monorepo execution:** positive, negative, path, and relational `--filter` patterns, topological order, per-package `cwd`, pre/main/post hooks, `PATH`/env, stdin/PTY, cancellation/signals, and exit codes, verified by fixtures that fail loudly if `--filter` is ignored.
- **Full-stack workflows:** dev server startup, loopback HTTP, `fetch`, WebSockets, preview origin routing, SQLite/TCP/Unix/TLS database access, file watch/HMR, production build, and clean teardown.
- **Shared state:** concurrent installers and SQLite writers, multi-tab edits, process death during cache publication, OPFS reload, worker cancellation, and descriptor/port cleanup.
- **Engine boundary:** ESM cycles, live bindings, top-level await, CJS/ESM singleton identity, `AsyncLocalStorage`, exceptions/reentrancy, lone surrogates, `BigInt`, buffer detach, and async settlement across browser default and optional engines.

Use pinned native Bun 1.4.5 as the semantic oracle. Name and test intentional platform differences at the boundary, and fail explicitly whenever a capability is absent.

## Appendix A. Local crates and code inventory

Physical line counts across `.rs`, `.ts`, `.tsx`, `.js`, `.c`, `.cpp`, `.h`, and `.mjs` files (including build scripts, tests, and generated tables), updated at `e51d22ae7` (post-`#1108`):

| Crate | Code files | Physical lines | Ownership |
| --- | ---: | ---: | --- |
| [crates/bunwasm-build](../crates/bunwasm-build) | 18 | 4,079 | Upstream bundler, CSS, markdown, adapted CLI/Bake, capability stubs |
| [crates/bunwasm-bun-jsc](../crates/bunwasm-bun-jsc) | 1 | 132 | Call-scoped scalar facade for selected upstream host functions |
| [crates/bunwasm-bun-jsc-macros](../crates/bunwasm-bun-jsc-macros) | 1 | 23 | Narrow `host_fn` macro facade |
| [crates/bunwasm-cli](../crates/bunwasm-cli) | 10 | 2,287 | Local CLI dispatch and compiler/runtime wiring |
| [crates/bunwasm-crypto-sys](../crates/bunwasm-crypto-sys) | 10 | 1,429 | BoringSSL build, FFI, and C adapters (separate source pin) |
| [crates/bunwasm-engine-hermes](../crates/bunwasm-engine-hermes) | 4 | 1,175 | Dormant engine adapter |
| [crates/bunwasm-engine-jsc](../crates/bunwasm-engine-jsc) | 3 | 1,031 | Optional JSC engine adapter |
| [crates/bunwasm-engine-quickjs](../crates/bunwasm-engine-quickjs) | 24 | 5,064 | Optional QuickJS adapter plus shared engine driver, natives, and loader |
| [crates/bunwasm-engine-spidermonkey](../crates/bunwasm-engine-spidermonkey) | 4 | 923 | Experimental SpiderMonkey engine adapter |
| [crates/bunwasm-glue](../crates/bunwasm-glue) | 5 | 1,952 | Portable parser/bundler C symbols, copied support shim, stubs |
| [crates/bunwasm-hermes](../crates/bunwasm-hermes) | 6 | 1,539 | Dormant Hermes VM build and C++ shim |
| [crates/bunwasm-host](../crates/bunwasm-host) | 42 | 26,108 | Native Wasmtime launcher, network/process/shared-memory ABI, tests |
| [crates/bunwasm-jsc](../crates/bunwasm-jsc) | 8 | 2,568 | WebKit/JSC VM build and C/C++ helpers |
| [crates/bunwasm-lint-native](../crates/bunwasm-lint-native) | 3 | 361 | Selected upstream regex/number support and ICU4X normalization |
| [crates/bunwasm-nested](../crates/bunwasm-nested) | 10 | 2,923 | Nested Wasm region rewriting and admission |
| [crates/bunwasm-posix](../crates/bunwasm-posix) | 4 | 659 | POSIX fallback layer and `mmap` emulation |
| [crates/bunwasm-runtime](../crates/bunwasm-runtime) | 370 | 122,412 | Local runtime, APIs, custom installer (15,404 lines after `#1108`), loader, generated builtins |
| [crates/bunwasm-semver](../crates/bunwasm-semver) | 1 | 34 | Direct selected upstream semver host functions |
| [crates/bunwasm-spidermonkey](../crates/bunwasm-spidermonkey) | 32 | 10,145 | SpiderMonkey VM, shims, generated tables, WASI glue |
| [crates/bunwasm-tools](../crates/bunwasm-tools) | 8 | 1,985 | Lazy upstream lint, fmt, and check drivers |
| [crates/bunwasm-transpiler](../crates/bunwasm-transpiler) | 8 | 4,482 | Upstream parse/print plus host source preparation and registration |

Top-level host and documentation trees at `e51d22ae7`: [src/](../src/) holds 23 files (1,749 lines) for package, asset, and process registration; [web/src/](../web/src/) holds 130 files (22,577 lines) for worker, engine, network, fetch/cache, preview, and demo integration; [docs/](../docs/) holds architecture, patch provenance, compatibility, and measurement records.

## Appendix B. Direct vendor dependencies

Local Cargo manifests declare **34 direct path dependencies inside `vendor/bun`**: 32 Bun crates plus 2 upstream-vendored third-party crates (`argon2` and `lol_html`).

| Name | Upstream path | Direct local users |
| --- | --- | --- |
| `bun_alloc` | `vendor/bun/src/bun_alloc` | `bunwasm-build`, `bunwasm-transpiler`, `bunwasm-bun-jsc`, `bunwasm-tools` |
| `bun_ast` | `vendor/bun/src/ast` | `bunwasm-build`, `bunwasm-transpiler`, `bunwasm-tools`, `bunwasm-glue` |
| `bun_brotli_sys` | `vendor/bun/src/brotli_sys` | `bunwasm-runtime` |
| `bun_bundler` | `vendor/bun/src/bundler` | `bunwasm-build`, `bunwasm-transpiler` |
| `bun_clap` | `vendor/bun/src/clap` | `bunwasm-tools` |
| `bun_collections` | `vendor/bun/src/collections` | `bunwasm-build` |
| `bun_core` | `vendor/bun/src/bun_core` | `bunwasm-build`, `bunwasm-runtime`, `bunwasm-tools`, `bunwasm-semver`, `bunwasm-glue` |
| `bun_css` | `vendor/bun/src/css` | `bunwasm-build` |
| `bun_dotenv` | `vendor/bun/src/dotenv` | `bunwasm-build`, `bunwasm-runtime` |
| `bun_errno` | `vendor/bun/src/errno` | `bunwasm-build` |
| `bun_event_loop` | `vendor/bun/src/event_loop` | `bunwasm-build` |
| `bun_glob` | `vendor/bun/src/glob` | `bunwasm-runtime` |
| `bun_install_types` | `vendor/bun/src/install_types` | `bunwasm-build`, `bunwasm-glue` |
| `bun_io` | `vendor/bun/src/io` | `bunwasm-build` |
| `bun_js_parser` | `vendor/bun/src/js_parser` | `bunwasm-build`, `bunwasm-transpiler`, `bunwasm-glue` |
| `bun_js_printer` | `vendor/bun/src/js_printer` | `bunwasm-build`, `bunwasm-transpiler` |
| `bun_lint_driver` | `vendor/bun/src/lint/driver` | `bunwasm-tools` |
| `bun_md` | `vendor/bun/src/md` | `bunwasm-build` |
| `bun_node_path` | `vendor/bun/src/node_path` | `bunwasm-runtime` |
| `bun_options_types` | `vendor/bun/src/options_types` | `bunwasm-build`, `bunwasm-transpiler` |
| `bun_parsers` | `vendor/bun/src/parsers` | `bunwasm-transpiler`, `bunwasm-tools` |
| `bun_paths` | `vendor/bun/src/paths` | `bunwasm-build`, `bunwasm-runtime`, `bunwasm-tools` |
| `bun_ptr` | `vendor/bun/src/ptr` | `bunwasm-build` |
| `bun_resolver` | `vendor/bun/src/resolver` | `bunwasm-build`, `bunwasm-transpiler` |
| `bun_sema_driver` | `vendor/bun/src/sema/driver` | `bunwasm-tools` |
| `bun_semver` | `vendor/bun/src/semver` | `bunwasm-runtime`, `bunwasm-semver`, `bunwasm-glue` |
| `bun_sourcemap` | `vendor/bun/src/sourcemap` | `bunwasm-build`, `bunwasm-transpiler` |
| `bun_sys` | `vendor/bun/src/sys` | `bunwasm-build`, `bunwasm-transpiler`, `bunwasm-runtime` |
| `bun_text_diff` | `vendor/bun/src/text_diff` | `bunwasm-runtime` |
| `bun_threading` | `vendor/bun/src/threading` | `bunwasm-glue` |
| `bun_wyhash` | `vendor/bun/src/wyhash` | `bunwasm-build`, `bunwasm-transpiler`, `bunwasm-runtime` |
| `bun_zstd` | `vendor/bun/src/zstd` | `bunwasm-runtime`, `bunwasm-tools` |
| `argon2` (`rust-argon2`) | `vendor/bun/vendor/rust-argon2` | `bunwasm-runtime` |
| `lol_html` | `vendor/bun/vendor/lolhtml` | `bunwasm-runtime` |

Directly included upstream modules outside their owning crates: [src/semver_jsc/SemverObject.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/semver_jsc/SemverObject.rs), `src/runtime/bake/dev_server/{incremental_graph,packed_map,serialized_failure}.rs`, and [src/runtime/cli/typescript_libs.rs](https://github.com/oven-sh/bun/blob/a7733435cf40429e3b35c36072769df2052b80f1/src/runtime/cli/typescript_libs.rs). Generated and extracted upstream C and JS sources are tracked separately in [docs/bun-patches.md](bun-patches.md) and [docs/bun-builtins.md](bun-builtins.md).
