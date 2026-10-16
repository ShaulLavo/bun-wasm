# Installing npm packages

`bun install` (`bun i`, or `bun ci` for a frozen lockfile), `bun add` (`bun a`), `bun remove` (`bun rm`, `bun r`,
`bun uninstall`) and `bun pm ls` run in all three engines. The installer runs in
Rust before starting the JS engine. The native launcher supplies network access;
the playground and sandbox use their existing page fetch bridge. Plain wasmtime
without a network host cannot download packages.

```sh
bun install
bun add react react-dom
bun add -D --exact typescript@5.9.3
bun remove typescript
bun pm ls
```

Set `NPM_CONFIG_REGISTRY` (or `npm_config_registry`), `--registry`, or
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
postinstalls` message. No native executables run. Workspace, git, local-file,
alias and isolated-linker installs, registry authentication, package binaries,
patches and overrides are not implemented. Symlinks and hardlinks inside npm
tarballs are rejected. Downloads and expanded packages are limited to 256 MiB;
the graph is limited to 10,000 packages and 128 nesting levels.

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

On wasm32-wasip1, the installer selects Rollup 4's official `@rollup/wasm-node`
distribution at the exact version selected for `rollup`. This policy applies to
root and transitive dependencies. Projects keep their existing dependency names
and imports. The package installs at the requested `node_modules/rollup` path;
its original package name, files, tarball integrity, and version remain intact.
The lockfile records the actual distribution identity under that path. Frozen
reinstalls use that identity. Rollup versions before 4 keep their original
JavaScript distribution. A missing same-version wasm distribution fails install.

QuickJS and JSC wasm execute the published parser through the Rust `wasmi`
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
