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

## Node parallel tests after main-thread worker imports

Status: Approved

The worker-thread main-thread adapter lets Node's shared helper load. The bounded
160-file census in [the worker-thread report](../docs/worker-threads.md) now reaches
existing module gaps. Keep these separate from guest-worker execution.

- `js/node/test/parallel/test-als-defaultvalue-original.js` and
  `test-als-defaultvalue.js` fail with `AssertionError: Expected values to be
  strictly equal` and `expected: "default"` on all engines. The
  `AsyncLocalStorage` class at `crates/bunwasm-runtime/src/js/builtins.js:370` has
  no options constructor and `getStore()` returns `undefined` without a frame.
  Add the actual default-value and naming contract, then measure these files.
- `test-arm-math-illegal-instruction.js` and
  `test-assert-calltracker-getCalls.js` reach `No such built-in module: node:test`.
  Implement the Node test API through the builtin loader where possible, with its
  lifecycle and reporting behavior; do not merely suppress the import.
- `test-async-local-storage-http-agent.js` times out with no stdout or stderr
  after five seconds on QuickJS and fifteen seconds on JSC. The test requires a
  response after `r2.write(payload)` before calling `r2.end('')` in that response
  callback. That census used a buffered `ClientRequest.write` path. PR #35 now
  starts socket writes before `end()` through `_write`; repeat this test on the
  HTTP integration before retaining the old client-buffering diagnosis. Inspect
  incoming request-body dispatch and async-context propagation for any remaining
  exchange failure. The browser engine fails earlier at the first response callback,
  with `actual: undefined`, `expected: "first"` for `cls.getStore()` at upstream
  line 39. Implement request streaming through the HTTP host contract and
  preserve async context across the response callbacks. The timeout is newly
  reached after the helper import succeeds; there were no passing files lost.

- `test-child-process-can-write-to-stdout.js` intermittently fails on the timer-corrected
  browser wasm before the WebSocket rebase. Its exit listener sees
  `output === ''` instead of
  `'hello, world!\n'` at upstream line 21. The first post-change census passed it;
  the timer-corrected census failed it. Two of three isolated repetitions on that
  same wasm fail, and one passes. The combined census after the WebSocket rebase
  passes it. These are `final-after-browser.json` and
  `stdout-repeat-{1,2,3}.json`. Start at the child waiter in
  `crates/bunwasm-runtime/src/js/spawn.js:248`, which resolves exit before reading
  pipes in that turn, and Node event reporting at line 415. Trace host pipe
  completion and Node data-event delivery before choosing a change; preserve the
  distinct exit and close events. PR 30 later changed pipe handling and stream
  error callbacks, so repeat the reproduction on that integration before assuming
  the failure remains. No subprocess code changes in this PR.

Exact source, runtime and dependency hashes, errors and timeout records are in
`/work/reports/bun-wasm-worker-threads/before-<engine>.json` and
`rebased-after-<engine>.json`, with `before-jsc-warm.json` as the valid JSC
baseline. The earlier `final-after-*` files retain the stdout investigation.
Those files are retained until coordinator acceptance. Reproduce one failure
after rebuilding the engine and warming the native launcher:

```sh
source env.sh
scripts/bun-suite.sh --engine quickjs --jobs 1 --timeout 60 \
  --output /work/tmp/bun-wasm-node-http-agent.json \
  js/node/test/parallel/test-async-local-storage-http-agent.js
```

Select either ALS or node:test file above with the same command when working on
that module. Use the heavy-job wrapper and a private native launcher target.

## MessagePort constructor errors and immediate-loop timer starvation

PR #31 review verification measured five unmodified Node message-port files on
all three engines before and after the close and receive fixes. Each engine
passes 3/5 files in both runs. The two failures below predate those fixes.
Evidence is in `/work/reports/bun-wasm-worker-threads-review-20261017/`, in the
`before-suite-<engine>.json` and `after-suite-<engine>.json` records. The runtime
fix was measured at `566601003675d08c912ff5fe6e88fe8f4ee3dfd0`, against the original
worker factory at `44fafb4e3cd5df8dac49a0423486a38448a82934`. The upstream suite
revision is `cd95fa7a13b3f13be73e512b38ec111c1c228084` in both runs.

- `js/node/test/parallel/test-worker-message-port-constructor.js:14` calls
  `MessagePort()` without `new` and expects `ERR_CONSTRUCT_CALL_INVALID`.
  The class at `crates/bunwasm-runtime/src/js/worker_threads.ts:48` throws the
  engine-generated TypeError before its constructor executes, so the error
  has no code. QuickJS, JSC, and browser each fail this assertion before and
  after the review fix. Preserve `instanceof`, constructor identity, and the
  illegal-constructor checks when fixing the callable entry point.
- `js/node/test/parallel/test-worker-message-port-infinite-message-loop.js:22`
  fails with `AssertionError: hit 10001 loop iterations` on all three engines,
  before and after the fix. The listener posts another message to itself and
  schedules a zero-delay timer to close the port. The dynamically growing
  `immediates` queue in `crates/bunwasm-runtime/src/js/bootstrap.js:390` drains
  before the next timer turn. Bounded MessagePort delivery batches still
  schedule another immediate, so they do not solve this shared scheduler bug.
  Keep timer fairness and active-batch close ordering as separate assertions.

After rebuilding the desired engine and native launcher in private targets,
run this bounded reproduction through the slot wrapper. Substitute `jsc` or
`browser` to repeat it on the other engines.

```sh
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light "MessagePort compatibility follow-ups" -- \
  env PATH="$PATH" scripts/bun-suite.sh --engine quickjs --network loopback \
  --jobs 1 --timeout 15 --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --output /work/tmp/bun-wasm-message-port-followups.json \
  js/node/test/parallel/test-worker-message-port-constructor.js \
  js/node/test/parallel/test-worker-message-port-infinite-message-loop.js
```

## Guest worker follow-ups

The initial run at `9f780ca411096b1bdae995d729982aaa9160b521` recorded 67/120
clean exits on each engine, compared with 21/120 at Step 1 revision `8596b11a`.
The review fixes below expose five earlier false passes and add two real passes,
leaving 64/120 on every engine. Repeating the census after Streams and persistence
integration gives the same result. Observed assertion counters remain zero.
[The worker report](../docs/worker-threads.md#guest-worker-measurement) contains
the exact selection and full gate results. Raw records are retained under
`/work/reports/bun-wasm-worker-execution/` until coordinator acceptance.

### Shared memory and transferable engine objects

`tests/esbuild/run.mjs`, with `ESBUILD_CHECKS=sync.cjs`, still has no fully passing
engine run before or after guest workers. Its four synchronous APIs need a shared
buffer between the caller and worker. QuickJS and the browser engine now stop in
`worker_codec.ts` with `DataCloneError`; JSC stops in esbuild's `lib/main.js:1941`
with `SharedArrayBuffer is not defined`. The three raw runs are in
`esbuild-before.log` and `esbuild-after.log`. The final aggregate repeats earlier
output, so raw occurrences of `PASS` are not a count of independent checks.

Implement real shared backing storage and atomic access across guest instances.
Do not copy SharedArrayBuffer bytes or force the package onto its other backend.
WebAssembly.Module cloning also remains unsupported by the guest codec. Keep
these objects separate from the existing byte-copy ArrayBuffer transfer and
routed MessagePort transfer. Reproduce through the heavy wrapper using the
commands in the worker report and the unchanged official esbuild package.

### Vite's builtin lookup before worker pools

The same frozen offline cache gives six successful installs and twelve failed
commands both before and after. This includes Vite React dev/build, Vitest's
default pool, and its explicit `--pool=threads` row on all three engines.
The first diagnostic is `ENOENT: no such file or directory, open 'ws'` at Vite's
`import.meta.require("ws").WebSocketServer` in `dist/node/chunks/config.js`.
The Vitest browser-engine log points to line 20578; the Vite React build log
points to line 23728. The error precedes worker construction. The portable ws
builtin is present, so inspect whether `import.meta.require` follows the same
builtin lookup as ordinary `require`; the exact cause is not established here.

Reproduce with `scripts/app-matrix.sh --apps=vitest,vite-react --hosts=native
--engines=quickjs,jsc,browser --timeout=45 --cache=<offline-mirror>
--launcher=<private-launcher> --output=<fresh-directory>`. The retained
`apps-before-complete/` and `apps-after/` records both have zero registry misses
and errors. Do not alter the real package sources to bypass this lookup.

### Browser-host round-trip deadline

Only the browser engine times out in
`js/node/test/parallel/test-worker-message-port-message-before-close.js` at the
shared fifteen-second deadline. This file performs 10,000 cross-guest port round
trips. QuickJS and JSC complete it in the same census. No output appears before
the browser deadline. Reproduce it alone with `scripts/bun-suite.sh --engine
browser --jobs 1 --timeout 60 --output <fresh.json>` and that file path before
claiming either a scheduling bug or a performance cause. Start by tracing control
pipe notification in `web/src/subprocess.js`, including its four-millisecond
watch interval. No timing optimization or cause is claimed by this measurement.

### Worker errors exposed by the review fixes

Status: Approved. Follow up in the process, module-loader and tracing tracks.

The #37 review fixes stop swallowing Worker errors and exceptions from parent
listeners. The same 120-file census changes from 67 to 64 fully passing files on
each engine. `test-worker-nested-uncaught.js` and
`test-worker-terminate-unrefed.js` now pass. Five earlier clean exits concealed
errors. Each engine exposes the same five cases in this comparison. These files are assertion scripts, so observed assertion counters
are zero before and after.

| File under `js/node/test/parallel/` | Newly visible failure | Starting point |
| --- | --- | --- |
| `test-process-execve-worker-threads.js` | Expected `TypeError` with `ERR_WORKER_UNSUPPORTED_OPERATION`; absent `process.execve` produces a plain TypeError. | `src/js/process.js` lacks the API. Define the worker-only unsupported-operation behavior with a Node/Bun control first. |
| `test-trace-events-api-worker-disabled.js` | Expected `ERR_TRACE_EVENTS_UNAVAILABLE`; receives `MODULE_NOT_FOUND`. | The builtin registry lacks `trace_events`. Determine main-thread support and the worker-specific rejection together. |
| `test-worker-dns-terminate-during-query.js` | `dgram.createSocket('udp4')` throws `ERR_NOT_SUPPORTED_IN_WASM`. | Existing UDP platform limitation. The worker error now correctly fails the parent. |
| `test-worker-esm-missing-main.js` | Expected `Cannot find module ...`; receives `Module not found "..."`. | `src/js/bootstrap.js` main-entry existence check. Compare native Bun and Node before changing the shared loader's diagnostic contract. |
| `test-worker-syntax-error-file.js` | Expected a `SyntaxError` constructor; receives `Error`. | `src/modules.rs::build_error` creates BuildError metadata; `src/js/worker_codec.ts` decodes unknown error constructors as Error. Trace the loader error before deciding where Node Worker normalization belongs. |

Runtime paths above are relative to `crates/bunwasm-runtime`. Raw before/after
JSON, stderr excerpts, hashes and the comparison script are retained at
`/work/reports/bun-wasm-worker-r37/` until coordinator acceptance. Reproduce each
file with `scripts/bun-suite.sh --engine quickjs --jobs 1 --timeout 15 --output
<fresh.json> js/node/test/parallel/<file>` through the heavy wrapper. Repeat with
`jsc` and `browser`. Preserve correct uncaught-error propagation while addressing
the owning API or diagnostic gap.

### Resolved full-web memory-growth gate

The original full web gate failed after 243 unit passes and all six real-browser
worker runs. Chromium's first growth guest in `web/tests/browser-memory.mjs:65` times out
after 120 seconds and reports `null !== 0`. Its program is the unchanged
`tests/fixtures/memory-grow/index.js`, which writes and reads a 48 MiB file.
The same main failure was independently recorded during
[Step 1 review](https://github.com/ShaulLavo/bun-wasm/pull/31#issuecomment-6225280460).
This lane did not change the memory test or the filesystem implementation.

The original Step 2 run reported this blocker in
[this comment](https://github.com/ShaulLavo/bun-wasm/pull/31#issuecomment-6225879642).
PR #36 fixed the shared filesystem capacity problem. It is merged into the #37
review-fix branch. The repeated memory gate now passes all six Chromium/WebKit
and engine combinations. This is no longer a Worker delivery blocker.

### Node stream adapter census after unavailable worker detection

The PR12 round-5 merge includes main `0cffef1`. All 22 selected Node adapter
files are currently nonpassing on QuickJS, JSC and Node-host browser. The shared
upstream harness imports `worker_threads` at `test/js/node/test/common/index.js:34`
and receives `ERR_NOT_SUPPORTED_IN_WASM`. Main intentionally changed that module
to reject loading so packages can detect absent worker support. Do not restore
the earlier fabricated worker constructor to make this harness collect.

Reproduce with `scripts/bun-suite.sh --node-parallel --engine quickjs --jobs 1
--timeout 15 --network loopback --output <fresh-output.json>
js/node/test/parallel/test-readable-from-web-enqueue-then-close.js`, repeated for
JSC and browser. The full fixed selection is
`docs/bun-test-suite/stream-adapter-files.txt`. Exact outcomes and wasm provenance
are retained at `/work/reports/bun-wasm-streams-round5-2026-10-16/final-adapter-*.json`.
All three current full fixture gates pass 152/152. Runtime stream behavior is
not established by these non-collecting upstream files. The compatibility track
owns resolving the upstream harness/capability boundary and removes the retained
evidence after reproduction and independent review.

### Native stream construction overhead

The PR12 round-5 bounded probe creates, closes and cancels 10,000 native
readables, then repeats through the construction bridge. On the M1 Mac with
Chromium 153 it measured 14.1ms native and 35.3ms bridged; WebKit 26.6 measured
19ms and 45ms. These single-run timings include serial cancellation awaits,
have no warmup/GC control and are labeled noisy, not a performance improvement.
Reproduce with `node scripts/test-native-stream-interop.mjs --benchmark` using
Playwright Chromium and WebKit. Raw source and browser/version provenance are
in `/work/reports/bun-wasm-streams-round5-2026-10-16/mac-final30.log`.

Completion records are currently allocated eagerly by `construct` in
`web/src/native-stream-state.ts`. If stream construction is hot in a real app,
measure lazy completion-record allocation while retaining eager controller
capture, pre-start abort propagation, native brands and both Transform ports.
The 30-case browser fixture and all-engine lifecycle fixtures must stay green.
The compatibility/performance track owns that work and evidence removal after
reproduction. Round 5 deliberately leaves allocation behavior unchanged.

### Browser memory-growth gate after shared filesystem main

Status: Resolved by PR #36. The round-2 HTTP branch includes the Streams and
filesystem merges and has passed the full web gate without the old exemption.
The following measurements describe the historical failure.

The Streams/TCP integration at `c0793417` merges main through `c7f08312`.
All 167 CLI fixtures pass on QuickJS, JSC and Node-host browser, including
`memory-grow`, and networking/Streams/browser/HMR checks pass. The full web gate
still times out in `web/tests/browser-memory.mjs:65`: the first Chromium guest
never completes, yielding `code: null` and `^C` after the unchanged 120-second
limit. The guest at `tests/fixtures/memory-grow/index.js` writes and reads a
48 MiB file. Native memory-view checks pass before it stalls.

Before the filesystem merge, the same Streams/TCP tree passed all six memory
engine/browser combinations. Main's filesystem merge changes no embedded
runtime or launcher source; that input comparison is retained in
`/work/reports/bun-wasm-streams-round6-2026-10-16/fs-main-native-input-diff.txt`.
The new real-browser shared filesystem path is the next boundary to inspect,
especially `runtime/fs/shared.ts`, `runtime/fs/client.ts` and `runtime/fs/backend.ts`.

Reproduce after building web assets with `PLAYWRIGHT=<playwright/index.mjs>
node web/tests/browser-memory.mjs chromium`, or `scripts/test-web.sh` in full,
through the heavy wrapper. The exact failed web log, full gate script, artifact
hashes and all passing stage logs are retained in
`/work/reports/bun-wasm-streams-round6-2026-10-16/`.
The runtime-filesystem/crypto landing lane already has a separate candidate
`fix/browser-memory-shared-fs` at `fae037bff367bca0f15be73b4d952207c885da6f`.
That dependency has landed in PR #36, and the branch reruns the memory
and full web gates. Do not reduce the guest allocation, relax its timeout or
remove assertions to call the gate passing. The owning lane removes retained
evidence after reproduction, review and merge.

## WebKit worker module-loader cancellation crash on macOS

Status: Approved. The browser/runtime compatibility track owns diagnosis and
upstream reporting. Keep this separate from the missing-module retry repair.

On macOS 26.4 / Apple M1, Playwright 1.64.1 WebKit revision 2370 crashed its
WebContent process during `node web/tests/browser-worker-modules.ts`. The
bundle included main `a70d3a1` and freshly rebuilt guest artifacts. Chromium
passed 20/20 atomic-transfer trials and the uncontrolled-child case. WebKit
passed 10 trials before `page.evaluate: Target page, context or browser has
been closed`. One run was observed; a diagnostic rerun was interrupted by
the next task assignment. The readiness regression itself passed 20/20 in
each browser and all six engine/browser API combinations.

The macOS crash report records PID 79405, `EXC_BAD_ACCESS / SIGSEGV`, invalid
address `0x10`, on `WebCore: Worker`. The first frames are
`WorkerThreadableLoader::MainThreadBridge::cancel()`,
`WorkerScriptLoader::cancel()`, and `WorkerModuleScriptLoader` destruction.
This is a browser-process crash, with no observed eval-module HTTP error.
Do not classify it as the earlier service-worker 404 or weaken the test.

Reproduce using a current PC-built web bundle transferred to the Mac,
`PLAYWRIGHT=<local playwright/index.mjs> node web/tests/browser-worker-modules.ts
webkit`, with the normal cross-origin-isolated server and an explicit free
`BUN_WASM_TEST_PORT`. Inspect worker termination while a module load is being
cancelled, starting with `web/src/subprocess-broker.ts` physical teardown.
The current integration case has not been reduced to a standalone browser
reproducer. Retained evidence is
`/work/reports/bun-wasm-signal-readiness/final/results/worker-modules.log`,
`webkit-crash-summary.json`, and `rebuilt-wasm-sha256.txt`. The compatibility
track removes these after reproducing and accepting the finding.
