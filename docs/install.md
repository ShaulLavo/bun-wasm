# Installing npm packages

`bun install` (`bun i`, or `bun ci` for a frozen lockfile), `bun add` (`bun a`), `bun remove` (`bun rm`, `bun r`,
`bun uninstall`), `bun update`, `bun x` and `bun pm ls` run in all three engines. The installer runs in
Rust before starting the JS engine. The native launcher supplies network access;
the playground and sandbox use their existing page fetch bridge. Plain wasmtime
without a network host cannot download packages.

```sh
bun install
bun add react react-dom
bun add -D --exact typescript@5.9.3
bun remove typescript
bun update react
bun update react --latest
bun x prettier@3.6.2 --version
bun pm ls
```

Set `BUN_CONFIG_REGISTRY`, `NPM_CONFIG_REGISTRY` or `npm_config_registry`, `--registry`, or
`bunfig.toml` to use a different registry:

```toml
[install]
registry = "https://registry.npmjs.org"
```

The installer fetches abbreviated npm packuments, selects versions with Bun's
`bun_semver`, verifies SHA-512 integrity (SHA-1 for older registry records), and
extracts tarballs with Rust `flate2` and `tar`. Bun's data parsers read
package.json, bunfig.toml and the JSONC text lockfile. Root dependencies take
priority in the hoisted node_modules tree; incompatible transitive versions go
under their dependent package. Required peers are installed, incompatible peers
produce warnings, optional peers are skipped, and unavailable optional packages
produce warnings. Native platform packages incompatible with WASI are skipped
when optional.

New lockfiles use Bun's text `bun.lock` version 2/config version 1. Simple project
output matches native Bun's lockfile byte for byte, checked against a local
registry golden. Existing locked resolutions and integrity hashes are reused,
including when a dist-tag changes. `--frozen-lockfile` rejects changes.
`--production` omits dev dependencies and preserves the full lockfile.

Tarballs and packuments are cached in `$BUN_INSTALL_CACHE_DIR`, or
`$HOME/.bun/install/cache/bun-wasm` (relative to cwd when HOME is absent).
Packuments expire after five minutes; integrity-checked tarballs do not expire.
The browser also persists installer downloads in Cache Storage under
`bun-wasm-install-v1`, across worker runs. It does not cache ordinary guest
fetches. These caches can be removed to reclaim space.
`BUN_CONFIG_HTTP_IDLE_TIMEOUT` sets the download idle timeout in seconds, with
a default of 300. Failed downloads are not retried.

Lifecycle scripts are always skipped, including scripts on trusted dependencies
and the root project. Packages with install hooks produce a `Blocked N
postinstalls` message. No native executables run. Workspace members and local directory links use the
hoisted graph. npm aliases select the target package without changing its files.
Git and isolated-linker installs, registry authentication, patches and overrides
are not implemented. Symlinks and hardlinks inside npm
tarballs are rejected. Downloads and expanded packages are limited to 256 MiB;
the graph is limited to 10,000 packages and 128 nesting levels.

## Workspaces, commands and migration

These additions are verified on the native hosts and Node's headless engine host
with a root preopen. Browser-page delivery is blocked by the shared filesystem's
missing symbolic-link support. Packages with `bin` entries now need that capability
when installation creates their command links. Do not enable this change in the
page until the [filesystem prerequisite](../plans/browser-runtime.md#installer-filesystem-link-prerequisite)
is complete. Node's native WASI also rejects some relative links under non-root
preopens; the bounded upstream comparison records that limit.


The installer discovers `workspaces` arrays and object-form `packages` patterns.
Members are linked into `node_modules`. Local `link:` and directory `file:`
dependencies resolve relative to the declaring manifest. Running `bun add` from
a member updates its manifest and the root lockfile.

Declared `bin` entries and `directories.bin` files get links under
`node_modules/.bin`. `bun run dev` resolves a package script and executes its
JavaScript or TypeScript binary in the selected engine. Quoted arguments,
environment assignments and extra command arguments are supported. Shell
pipelines, redirections and native commands remain unsupported.

`bun update` refreshes selected dependencies within their declared ranges.
`--latest` selects the latest tag. `bun x` and the `bunx` executable alias prefer an installed
binary for an unversioned request, then use an isolated cache installation.
They leave the project's manifest and lockfile unchanged. Concurrent installs
publish complete cache directories through an atomic rename.

Without `bun.lock`, the installer reads npm `package-lock.json`, pnpm
`pnpm-lock.yaml`, Yarn classic or Yarn Berry `yarn.lock` before resolution.
Migrated registry versions remain pinned. `bun pm migrate` writes the converted
lock without installing packages. Unsupported dependency protocols produce an
error rather than silently replacing a lockfile pin. `--lockfile-only` skips
package extraction. Registries may omit integrity, but supplied SHA-512 or
SHA-1 hashes are checked.

The [installer selection](bun-test-suite/installer-files.txt) lists the 25
upstream files assigned to this change. The `installer-gaps` runtime fixture
checks a synthetic registry, all four lockfile formats, workspace imports,
member changes, binaries, updates, and concurrent package execution.

## Real Bun installer spike

The pinned source is `4ceda2c2868d3a7703c7737ddd9de7244ec384df`. No vendor
patches were added for this task.

The existing `scripts/port-check.sh bun_install` cannot check this crate from
our outer workspace, which excludes Bun's installer. The script also hardcodes
its target directory and `-j12`, so the isolated probe used its equivalent
`cargo check --target wasm32-wasip1 --keep-going --message-format short -j6`
under a 4 GiB systemd scope. A disposable standalone manifest depended on
`vendor/bun/src/install` and patched libc to this repository's `third_party/libc`.
Checking the vendor workspace directly first failed on six missing mmap/MAP
names because it did not inherit that patch.

The corrected probe found **22 compiler errors**, four in `bun_dns` and eighteen
in `bun_spawn`. DNS needs `sockaddr_un`, `AI_V4MAPPED`, `AI_ADDRCONFIG` and
`AI_ALL`. Process code lacks WASI Poller/SpawnOptions/SpawnProcessResult and
stdio variants, plus ctrl_c and OS-specific match implementations. Those
failures prevent reaching `bun_http` and `bun_install` typechecking.
`bun_install_types`, `bun_semver`, `bun_parsers`, `bun_resolver`, the libarchive
Rust wrapper and `bun_event_loop` typechecked.

There are additional execution blockers after compilation:

- `src/http/HTTPThread.rs:1202` unconditionally starts a native thread and exits
  when spawning fails. The existing inline ThreadPool patch does not cover it.
- `src/install/PackageManager.rs:2329` initializes the uSockets loop;
  `:2508` starts that HTTP thread.
- `src/install/NetworkTask.rs:40` embeds AsyncHTTP, callbacks, streaming state
  and intrusive queues. A fetch adapter must replace that execution boundary.
- `src/install/TarballStream.rs:617` calls libarchive;
  `src/install/extract_tarball.rs:308` uses libdeflate. Typechecking the Rust
  wrapper does not supply the C libraries.
- Lifecycle and git paths pull in process facilities even when scripts are
  disabled.

The probe did not establish a working port within a few days. The runtime path
keeps the current task bounded while reusing Bun's semver and data parsers.
Bun's metadata parser (`src/install/npm.rs:2314`) and lock writer
(`src/install/lockfile/bun.lock.rs`) depend on installer-internal package tables,
so they cannot be linked as independent parser/serializer libraries.

## Verification

`tests/install/run.mjs` starts a local CORS registry with deterministic tarballs.
It tests aliases, add/remove, all dev flags, exact versions, hoisting conflicts,
peers, optional dependencies, skipped lifecycle scripts, registry configuration,
lock reuse/offline reinstall, byte-exact lock output, integrity and archive
containment. A stalled registry checks the configurable HTTP idle timeout.
Tests never contact npm. `web/tests/browser-install.mjs` drives
`bun add is-odd` and a TS import in the playground across Chromium/WebKit and all
three engines. The headless Node host uses a separate fetch worker during synchronous
Rust CLI startup, then keeps its existing asynchronous network adapter for JS.
See [the fixture README](../tests/install/README.md).

Raw bounded upstream results and command logs live in
`/work/reports/bun-wasm-install/` for coordinator review. The install subset is
`cli/install` (113 files), run unchanged with `scripts/bun-suite.sh --network
loopback --jobs 2`. The checked-in full baseline is deliberately unchanged.

The worker verification results are:

| Check | Result |
| --- | --- |
| Local registry, QuickJS | 19 passed, 0 failed |
| Local registry, JSC | 19 passed, 0 failed |
| Local registry, Node host engine | 19 passed, 0 failed |
| Existing fixtures, each engine | 85 passed, 0 failed |
| Playground install workflow | 6 passed, 0 failed, Chromium/WebKit across three engines |
| Native Bun reference | 18 passed, 0 failed, 1 host bridge check skipped |
| Real npm, native launcher | React and React DOM 19.3.1 installed and imported |

| Upstream install subset | Before | After |
| --- | --- | --- |
| Files | 113 | 113 |
| Fully passing files | 0 | 0 |
| Timeouts | 0 | 0 |
| Observed passes | 200 | 233 |
| Observed failures | 4235 | 4203 |
| Skips | 83 | 83 |
| Todos | 22 | 22 |
| Errors | 42 | 42 |

The upstream subset remains broader than this installer. Workspace layouts,
package binaries, patches, migrations and additional commands still fail. The
before/after results are bounded observations, not a complete assertion census.
Installer requests use gzip; browsers select their own transport encoding.
The checked-in upstream baseline remains unchanged.

## WebAssembly distributions

On wasm32-wasip1, the installer selects official WebAssembly distributions at
exactly the version selected for the requested dependency:

| Requested package | Official distribution |
| --- | --- |
| `rollup` 4.x | `@rollup/wasm-node` |
| `esbuild` | `esbuild-wasm` |

This policy applies to root and transitive dependencies. Projects keep their
existing dependency names and imports. Each distribution installs at the
requested package path, such as `node_modules/esbuild`.
The distribution's original package name, files, tarball integrity, and version remain intact.
The lockfile records the actual distribution identity under that path. Frozen
reinstalls use that identity. Rollup versions before 4 keep their original
JavaScript distribution. A missing same-version wasm distribution fails install.

QuickJS and JSC wasm execute published guest wasm through the Rust `wasmi`
interpreter. The browser engine uses its native WebAssembly implementation.
The interpreter adapter supports numeric functions, JavaScript function imports,
exported 32-bit memories, and exported globals. It supports reentrant function imports,
i64 values, and memory growth with detached old buffers. Imported memories,
tables, standalone memory/global construction, shared memory, and JavaScript
imports called by a module's start function are not yet supported. The adapter
implements the listed subset of the WebAssembly JavaScript API. Aliased memory
exports share one object and buffer. Successful growth detaches the old buffer,
including zero-page growth from JavaScript or wasm; failed growth preserves it.
Numeric arguments, imported results, and global assignments use the JavaScript
API conversions. Invalid page counts throw TypeError, capacity failures throw
RangeError, and execution traps throw WebAssembly.RuntimeError. Exceptions from
JavaScript imports and coercion keep their original identity.

Compiled modules and instances are retained until the program exits, even after
their JavaScript wrappers become unreachable. Reuse modules and instances in
long-lived programs. Unbounded repeated compilation or instantiation is outside
this adapter's supported subset until interpreter handles can be reclaimed.
No upstream Rollup implementation is copied, patched, or replaced.

`bun tests/rollup/run.mjs` replays the real Rollup 4.64.7 distribution from the
app-matrix mirror. It checks the parser on Unicode and invalid syntax, the three
hash exports, a complete bundle generation, and a frozen reinstall on each engine. Set `BUN_WASM_LAUNCHER` to
your launcher and `ENGINES` to a comma-separated subset. This check never
records or contacts the public registry.

The unchanged `esbuild-wasm` Node API starts its JavaScript CLI through
`child_process.spawn("node", ...)`. Node commands use a fresh bun-wasm guest,
with the same engine, filesystem, and environment. Go's published `wasm_exec.js`
then runs `esbuild.wasm` through the guest WebAssembly API. The native launcher
and browser subprocess host supply pipes. Callback stdin reads yield to the
event loop while waiting for service packets. Browser workers share a live
filesystem service, so parent edits and child output files are visible independently
of stdin, stdout, or process exit. The service owns segmented storage growth, with
a default 1 GiB total storage cap and a 16 MiB limit per file; there are no
file-change snapshot messages. Plain wasmtime without a subprocess host cannot
use this API.

`MATRIX_CACHE=/path/to/mirror bun tests/esbuild/run.mjs` replays esbuild 0.25.12.
It checks TypeScript and Unicode transforms, invalid syntax, file bundles,
context rebuilds after a file change, plugin callbacks, the CLI, and frozen
reinstalls across all three engines. `bun tests/esbuild/browser.mjs` runs the
same API and CLI checks in the playground under Chromium and WebKit. Build
`web/` first. Both tests use the app-matrix mirror without contacting npm.


The esbuild port's local verification on 2026-10-16 passed:

| Check | Result |
| --- | --- |
| Complete runtime fixtures | 117 passed, 0 failed per engine |
| Deterministic installer fixtures | 20 passed, 0 failed per engine |
| Published esbuild API and CLI, native hosts | All three engines passed |
| Published esbuild API and CLI, Chromium and WebKit pages | All six engine/browser combinations passed |
| Browser host gate | Passed |
| Sandbox HMR | All six runs passed |

The package check includes live browser filesystem changes and context rebuilds.
The bounded upstream files `integration/esbuild/esbuild.test.ts` and
`cli/install/bun-install-cpu-os.test.ts` remain at 0 passes, 3 failures, 1 error,
and no timeouts before and after. The first file cannot download packages in
its loopback namespace; the second requires the missing `Bun.jest` harness API.
Those results do not exercise the published esbuild package, which has its own
recorded-registry check above. The full upstream baseline is unchanged.

[Framework results](app-matrix/esbuild-results.md) record the subsequent Vite,
Astro, and SvelteKit blockers. TCP and ws review heads changed after that pinned
integration measurement; the report does not claim to measure those later heads.

The esbuild package checks cover synchronous APIs and watch edits without an
explicit rebuild request on every engine, including Chromium and WebKit pages.
See [the package-check instructions](../tests/esbuild/README.md) for offline
mirror requirements and the retained official package recording.

## Installer command measurement, 2026-10-17

The fixed [25-file selection](bun-test-suite/installer-files.txt) covers every
workspace, manifest-header, lock-migration, update and bunx cause assigned by PR #40.
Each unchanged upstream file has a 15-second deadline and 2-second initial test
timeout, one worker, with loopback-only networking. The before artifacts are main
`390bda6d`; both sides use the same suite, launcher, runner, host sources,
dependencies and deadlines. Only the wasm hash differs within each engine pair. This measurement predates
the rebase onto main `63aae226` and the later selected-workspace update fix; it
does not measure those subsequent changes.

| Engine | Observed passes before / after | Fully passing files before / after | Timeouts before / after |
|---|---|---|---|
| quickjs | 18 / 109 | 0 / 3 | 0 / 0 |
| jsc | 18 / 109 | 0 / 3 | 0 / 0 |
| browser | 18 / 34 | 0 / 1 | 1 / 2 |

| Cause | Files | QuickJS passes before / after | JSC passes before / after | Browser passes before / after |
|---|---|---|---|---|
| Workspaces | 9 | 3 / 73 | 3 / 73 | 3 / 3 |
| Manifest Accept | 5 | 14 / 26 | 14 / 26 | 14 / 26 |
| Lock migration | 4 | 1 / 9 | 1 / 9 | 1 / 4 |
| Update | 4 | 0 / 0 | 0 / 0 | 0 / 0 |
| Bunx | 3 | 0 / 1 | 0 / 1 | 0 / 1 |

| Artifact | Before bytes | After bytes | Change |
|---|---|---|---|
| bun.wasm | 14959264 | 15060266 | +101002 |
| bun-jsc.wasm | 51459316 | 51629740 | +170424 |
| bun-browser.wasm | 14246896 | 14350056 | +103160 |

These are observed counts. They include only tests that registered before a
collection error or deadline. The browser counts have one additional timeout
after the change. Its workspace files are blocked by native Node WASI link
capabilities, so the browser and native pass gains are not interchangeable.
Security scanners, interactive update tables, global links, additional lockfile
protocols and exact upstream diagnostics remain outside this adapter.

At the measured revision, the focused synthetic checks passed on each engine:
20 existing installer cases, the update-pruning regression, and seven
installer/command scenarios. Standard runtime fixtures passed 201/201 per
engine. The full web script passed, including 817 unit tests and Chromium/WebKit
checks; HMR passed all six engine/browser combinations. The separate `browser-installer-links.ts` scenario checks the
browser-page filesystem prerequisite instead of treating headless results as
proof of page support.

The focused Chromium page probe confirmed the prerequisite: installing a plain
fixture package succeeds; adding a valid `bin` entry and reinstalling exits 1
with `error: Not supported (os error 58)`. The guest reads back the edited manifest
before the failing install, and every network request stays on the local fixture
origins. This change is not ready for browser-page delivery until the shared
filesystem supports those links.
