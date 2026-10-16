# Compatibility follow-ups

Status: Approved

## YAML stringify: throwing Symbol.toPrimitive on a boxed primitive

`js/bun/yaml/yaml.test.ts` used to trap with `wasm trap: call stack exhausted`
on QuickJS before its final report. The wave/stack-overflow PR turns that
recursion into a RangeError, and the file now runs to completion on every
engine. One test fails the same way on QuickJS, JSC and the browser engine,
before and after that PR: `Bun.YAML > stringify > JavaScript edge cases >
boxed primitive whose Symbol.toPrimitive throws propagates the error`
(`expect(received).toBe(expected)`). The browser engine also fails `parse
rejects an input of 2**31 bytes or more instead of panicking` (expected
`ERR_OUT_OF_RANGE`, received `undefined`).

```sh
source env.sh
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-yaml.json js/bun/yaml/yaml.test.ts
```

Start at `yamlStringify` in
`crates/bunwasm-runtime/src/js/formats.js`. Keep the upstream test unchanged.

## Integration with the separate HTTP/WebSocket lane

`js/node/http/node-http-with-ws.test.ts` changes from 25 failures and a completed
file to 24 observed failures and a 15-second file timeout after real server
async disposal is available. The first error is `Unexpected server response:
200` from `ws/lib/websocket.js:913`; the file expects Node HTTP upgrade support.
HTTP upgrade/WebSocket work belongs to the parallel lane, so no protocol
implementation was added here. Preserve the new close/drain contract when
integrating that lane and rerun this exact file through `scripts/bun-suite.sh`
with the same loopback/dependency arguments above. See `before-extra.json` and
`final.json` in the retained report directory.

The other new timeout in the measured selection is
`js/node/child_process/child_process.test.ts`: it previously stopped during
collection because Bun.semver was missing. It now reaches 26 passes, 55 failures,
4 skips and 1 todo before the file deadline. Its first failure invokes the
unimplemented `ChildProcess.spawn` instance method at line 71. Existing
subprocess/IPC support is a separate follow-up; do not restore the collection
failure to hide it.

## Package-manager cases reached by the portable semver bridge

Status: Approved

Adding `semverIntersects` lets `cli/install/semver.test.ts` register its tests.
Five package-manager cases fail on all three engines. The JSC measurement has
345 passes and five failures in that file, with no timeout. The separate
`regression/issue/08040.test.ts` still passes. Evidence is in
`/work/reports/bun-wasm-track2-2026-10-15/initial-after/`, especially
`jsc-after.json`. These failures are outside the semver host-function bridge.

Reproduce with a clean source reference and rebuilt artifacts:

```sh
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light "serial semver package-manager follow-up" -- \
  env PATH="$PATH" scripts/bun-suite.sh --engine jsc --network loopback --jobs 1 \
  --suite /work/projects/bun-wasm/vendor/bun \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-semver-package-manager.json cli/install/semver.test.ts
```

The runner snapshots the reference tree and executes tests in its disposable
copies. It does not run them in the shared checkout. Use a clean reference
because the runner rejects tracked source modifications.

The observed gaps are:

- `bun install --lockfile-only` fails with `error: Unknown install option: --lockfile-only`.
  The cases at upstream lines 1432 and 1673 need normal dependency and override
  resolution while writing only the lockfile. The argument parser currently
  rejects the option at `crates/bunwasm-runtime/src/install/mod.rs:54`.
- A dependency range above `u64::MAX` reports
  `No version matching "^99999999999999999999" found for specifier "foo"`.
  The test at upstream line 1646 expects the suffix ` (but package exists)`.
  `crates/bunwasm-runtime/src/install/resolve.rs:293` drops that distinction even
  though registry metadata was found. The invalid range is already rejected.
- `bun pm version <version> --no-git-tag-version` is not implemented. The two
  cases in the table at upstream lines 1715 and 1730 expect invalid current or requested
  versions to fail without changing `package.json`. They instead reach the
  install option parser and report
  `error: Unknown install option: --no-git-tag-version`.

Implement these in the package-manager track with its existing install fixtures.
Keep the upstream tests unchanged. Rerun the exact file on all three engines.
The portable bridge PR separately fixes the engine-specific Symbol error wording
and browser host GC recursion observed during the initial measurement.

## Stack overflow paths that still trap

The wave/stack-overflow PR makes JavaScript recursion, getters, Proxy traps,
JSON, the QuickJS parser and the console recursion control throw a catchable
`RangeError` on every engine and host; `docs/stack-limits.md` has the limits,
measurements and reproducer. These paths still end in a wasm trap:

- **JSC native recursion outside reentry.** On JSC-wasm, nested blocks, arrow
  functions and regexp groups spend about six times more host stack per
  shadow-stack byte than getters (block 1,248 host bytes per level against 550
  shadow bytes). On wasmtime's default 512 KiB stack, blocks trap after 415
  levels, arrows after 208 and regexp groups after 1,119, the same as before the
  stack PR. In WebKit with 512 KiB worker stacks and cold code, every parser
  nesting shape, regexp groups, `Array.prototype.flat`, Proxy chains without
  traps and plain `JSON.stringify` (`FastStringifier`) trap at 200,000 levels.
  On the native launcher's 16 MiB stack they all throw, except unary operator
  chains (`!!!…0`), which trap after 80,618 levels at any budget. Reproduce
  with `python3 scripts/measure-stack.py --engine jsc block arrow unary regexpnc
  flat proxychain jsonplain` (add `--host launcher --launcher
  "$CARGO_TARGET_DIR/release/bun-wasm"`) and the WebKit command in
  `docs/stack-limits.md`. Fix by reserving shadow bytes in those WebKit
  functions, as `js_reserve_wasm_frame` does in `quickjs.c`, then measure the
  ratios again. Shrinking the native budget instead would cut getter depth
  further. JSC's `maxPerThreadStackUsage` option is not a substitute: in the
  C-loop build it also sizes the JavaScript frame stack.
- **QuickJS reports a SyntaxError for a parse cut short near the limit.**
  Retrying `require()` of a TypeScript module one level further up after each
  RangeError, so that the first success parses with the least stack left, ends
  in an uncaught `SyntaxError: invalid property name` on QuickJS. It happens on
  every run of this source at the default and the 40 KiB budget, on main's
  parser plus this PR's guard. JSC and the browser engine load the module. A
  longer variant of the same script loads it too, so the outcome depends on
  how much stack remains. The parser's own stack check (in `next_token`) throws
  RangeError, so some path replaces that pending exception with a syntax
  error; `js_parse_property_name`'s callers all check its result, so start from
  the token handling around object literals. Repro:
  `/work/reports/bun-wasm-stack-2026-10-16/repro/require-near-limit.js`, run
  from a writable directory as `wasmtime run --dir .::/ --env PWD=/
  dist/bun.wasm run /require-near-limit.js`. The stack-overflow fixture covers
  the plain case: a `require()` from the deepest catch throws RangeError and
  the program goes on.
- **Bun's transpiler.** A module file with 2,000 nested array literals traps in
  `bun_js_parser` before QuickJS sees it (`const x = [[[...]]];`; 400 levels
  throw RangeError from QuickJS). `Bun__StackCheck__getMaxStack` in
  `crates/bunwasm-glue/src/bun_native.rs` returns 0 on the main thread, so
  `StackCheck::is_safe_to_recurse` always succeeds. Give the main thread a
  shadow-stack bound and measure the transpiler's host-per-shadow ratio before
  choosing it.

## JSC subprocess disposal timing

The ArrayBufferSink campaign exposed a variable result in upstream
`js/bun/spawn/spawn.test.ts`, case `dispose keyword works` at line 1387.
The integrated three-file measurement has five spawn passes and 172 failures.
A spawn-only repeat with identical wasm, launcher, runner and dependency hashes
has six passes and 171 failures. Only the disposal case changes status.
The sink file consistently has 13 passes and one skip. Raw results are retained
in `/work/tmp/bun-wasm-track4-sink-evidence/after-jsc-refreshed.json` and
`jsc-spawn-repeat.json` until coordinator review. The tracked sink report preserves
the counts after those local artifacts are removed.

Reproduce with the sink report's command and `--engine jsc`, selecting only
`js/bun/spawn/spawn.test.ts`, through the heavy wrapper. Trace child completion
before the disposal call in `crates/bunwasm-runtime/src/js/spawn.js:228` and the
signal state set by `kill()` at line 223. The child may already have settled;
that cause remains unconfirmed. No sink code or provenance changed in the repeat.
Keep this subprocess investigation separate from byte-sink behavior.


## Next after directory handles

Status: Approved

The controlled main + PR 12 + PR 18 integration at
`43d10f4e84997a51d07f8892ad72e739c2548fc3` runs the Next row on
all three freshly built engines. Only the browser engine reaches the missing directory API;
QuickJS and JSC stop earlier. Adding directory handles moves the browser build
from `TypeError: _promises.default.opendir is not a function` to
`Error: Child process IPC is not supported in bun-wasm`, code
`ERR_NOT_SUPPORTED_IN_WASM`, at `crates/bunwasm-runtime/src/js/spawn.js:411`.
Implement the actual child IPC transport and lifecycle rather than treating send
as successful. It spans the subprocess runtime and host workers and is outside
the directory-handle fix.

QuickJS and JSC dev and build both fail with
`LinkError: Unsupported WebAssembly export table` at
`crates/bunwasm-runtime/src/js/webassembly.js:136`. Next invokes it from
`node_modules/next/dist/compiled/@edge-runtime/primitives/load.js:5630` while
instantiating llhttp. The wasm bridge identifies table exports but has no public
table object adapter. Add real table/function-reference support through the wasm
native boundary and test it on both embedded engines. Do not suppress the export.

Run `scripts/app-matrix.sh --apps=next --hosts=native --engines=quickjs,jsc,browser
--launcher=<private-target>/release/bun-wasm --timeout=60 --output=<unused-report-dir>`
after rebuilding the same integration. Dev runs `bun run
node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port <free-port>`;
build runs `bun run node_modules/next/dist/bin/next build`. Both before and after
have three install passes, six failures and three blocked starts, with no
registry misses or errors. Browser dev exits without a diagnostic; its cause and
source location remain unconfirmed. Exact logs and artifact hashes are retained
in `/work/reports/bun-wasm-rv28-final-20261016/next-before/` and `next-after/`.

The pending WebCrypto integration also exposes a standalone-example build gap.
`scripts/build.sh` reaches `scripts/test-transpiler-example.sh:9`, then the linker
cannot find `-lc` with WebCrypto's `link-self-contained=no` flags. Restoring Rust's
libc alone exposes unresolved BoringSSL symbols. The local integration links that
example with the same SDK libc, C++ runtime and BoringSSL archive as the CLI, and
its compile/output/source-map check passes. The exact integration-only recipe is
retained as `integration-example-fix.patch` in the same report. Keep standalone
examples covered when landing the WebCrypto build configuration.
## Framework blockers reached after esbuild

The approved compatibility campaign now reaches the failures recorded in
[the esbuild framework measurement](../docs/app-matrix/esbuild-results.md).
Replay the exact pinned projects with `scripts/app-matrix.sh`; its command,
integration revisions, versions, artifact hashes, and log destination are in
that report. Do not file GitHub issues for these follow-ups.

The JSC React build needs a bounded engine investigation. It transforms 22
modules before the esbuild child traps in `JSC::JSLock::unlock` through
`JSObjectSetProperty` and `crates/bunwasm-runtime/src/engine_jsc.rs:232`.
`vite-react-jsc-build.log` preserves the complete wasm stack and the subsequent
`[vite:esbuild-transpile] The service was stopped` message. This has one observed
matrix failure, not a measured recurrence rate. The smaller official esbuild API
fixture passes on JSC, so a basic missing WebAssembly API is ruled out. Native
value lifetime, lock accounting, and GC during recursive value conversion remain
hypotheses; reproduce before changing the bridge.

The other exact first blockers are Astro's unresolved circular `Fragment`
binding on QuickJS, its missing `node:http2.Http2ServerResponse` export on JSC,
SvelteKit's unsupported `fs.watch` during dev, silent exit 1 during SvelteKit
builds on QuickJS and JSC, and the browser engine's unexpected-dot syntax error.
The six Vite dev rows on QuickJS and JSC have empty logs and no captured exit
code. Add exit/deadline provenance to the server measurement before assigning
those rows a cause. Preserve the passing Vite production-build controls while
investigating each failure.

## Browser memory-growth gate after the shared filesystem merge

Status: Approved. The coordinator's Web Crypto follow-up is investigating the same gate failure.

On main `c7f08312` with the HTTP lane applied, `scripts/test.sh` passes 153 fixtures
on every engine. `scripts/test-web.sh` reaches `web/tests/browser-memory.mjs:65`,
then Chromium's first guest run times out after 120 seconds. The assertion reports
`^C` and `null !== 0`. An isolated rerun of the same browser-memory command fails
the same way, so this is two failures in two attempts on the HTTP lane. The wave
log also records it while landing Web Crypto on main after the filesystem merge.

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
export PLAYWRIGHT=/home/shaul/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/.mise/playwright@1.63.0/node_modules/playwright/index.mjs
bash /work/tmp/wave-heavy/run.sh --class browser "browser memory gate" -- \
  env PATH="$PATH" PLAYWRIGHT="$PLAYWRIGHT" node web/tests/browser-memory.mjs
```

The guest is `tests/fixtures/memory-grow/index.js`, which writes and reads a 48 MiB
file after allocating its buffer. `runtime/fs/shared.ts:8` limits a file to 256
pages and `runtime/fs/protocol.ts` defines 64 KiB pages, giving a 16 MiB per-file
limit. `runtime/README.md` and `docs/install.md` document that limit and EFBIG.
Investigate the failure/error completion around shared growth and reconcile the
browser growth control with the documented file cap. Keep coverage that forces
wasm memory growth and then verifies host I/O.

The memory guest imports only `node:fs`; it does not exercise HTTP. Chromium's
memory-view control itself passes before the guest timeout. No HTTP or filesystem
workaround was added for this failure. An unchanged main-artifact control on main `4098772e` also reproduces the
timeout. Its binaries were checked against main's original HTTP and builtin
factory source; hashes are recorded in `main32-control-artifacts.json`. The final
HTTP run on main `9c1e1709` passes 154 fixtures per engine and reproduces the same
web-gate timeout. Raw logs
are retained at
`/work/reports/bun-wasm-http-20261016/after-web-tests.log` and
`/work/reports/bun-wasm-http-20261016/memory-recheck.log`, plus
`main32-memory.log` for the unchanged-main control. The coordinator owns
follow-up and evidence cleanup after the gate is fixed.
