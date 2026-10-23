# Compatibility follow-ups

## Global Web Worker census

Status: Approved.

The global constructor passes its lifecycle, transfer, preload, dependency-loading,
and top-level-await fixtures on all engines and in Chromium/WebKit. The eleven
upstream cause files now pass three files per engine. The
[measurement](../docs/worker-threads.md#global-constructor-measurement) records exact
counts and provenance. Reproduce through the suite slot with
`scripts/measure-web-workers.sh <engine> <fresh-output.json>` after private builds.
Raw logs are in `/work/reports/bun-wasm-web-worker/final/after-<engine>-logs/`.

- `worker-fixture-env.js` posts `process.env`, but `worker_codec.ts` rejects its
  Proxy representation with `DataCloneError`. Give the native environment object
  an explicit serialization contract without allowing arbitrary proxies.
- `worker.test.ts` requests `--no-deprecation` and `--tls-min-v1.2`; the
  `worker_threads.ts::execArguments` validator rejects them. Implement their
  runtime behavior before accepting them. VM timeout cases require `node:vm`,
  not changes to Worker delivery. The final run completes the entire worker file
  on every engine; earlier scheduling-related file timeouts are resolved by main.
- `worker-entry-point.test.ts` receives its error event for a builtin alias, but
  the guest additionally prints the generated throw to stderr. The too-long
  entry-path case receives the shared loader's diagnostic instead of Bun's
  `BuildMessage` text. Trace `web_worker.ts::target` and bootstrap fatal reporting
  together; retain ordinary explicit worker stderr.
- `worker_blob.test.ts` has four passes and two failures. Construction currently
  snapshots a local Blob, so immediate revocation does not cancel startup.
  A URL created in another guest is absent from the local Map. Add a broker-owned
  registry and its lookup/revocation lifetime rather than copying registry state.
- BroadcastChannel GC stress and several termination cases exceed the existing
  four-child host budget. Shared buffers/Atomics cannot cross guests. Preserve
  those limits until the transport supplies actual sharing and capacity.
  BroadcastChannel close-task ordering and custom inspection failures also
  predate the constructor; their diagnostics remain in the same raw census.

An earlier combined browser run lost three previously passing Node lifetime
assertions to `EAGAIN` after stress cases. All three pass in a fresh same-artifact
diagnostic; the final unfiltered comparison loses no observed passing assertions.
Do not treat unavailable heap counters as evidence of leak freedom. The
coordinator owns removal of these review records after accepting the follow-up
evidence.

Status: Approved

## YAML stringify: throwing Symbol.toPrimitive on a boxed primitive

Status: Resolved for boxed primitive coercion. The separate browser large-input
error-code gap remains Approved.

The YAML coercion adapter now consults `Symbol.toPrimitive` with the string or
number hint, preserves thrown values and reports invalid object results. It also
applies that conversion to indentation. `yaml-boxed-coercion` covers the guest
path; `scripts/yaml-coercion.test.ts` reproduces the original failure without a
guest build. Boolean wrappers retain their internal boolean value.

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

Reconciled against main `e0c85f2973ecaa594660ef36186daa08fdb13cf0` on
2026-10-24. The unchanged `cli/install/semver.test.ts` has 345 passes and five
failures on QuickJS, JSC and the browser host, without timeouts. The older report
below is superseded by `/work/reports/bun-wasm/package-options-20261024/`.

`--lockfile-only` is already implemented. Its range-intersection test passes.
The local package-options fixture proves metadata resolution, lockfile writes,
no payload requests or node_modules creation, preserved existing payloads,
immutable frozen locks and a later ordinary frozen install.

The package-options lane repairs the existing-package no-match diagnostic and
routes `pm version` before install option parsing. Failed current/requested
version validation preserves the original manifest bytes. Stable increments and
specific versions have positive native controls. Git operations, prerelease
increments and lifecycle execution remain explicitly unsupported in this bounded
command adapter.

The separately assigned package-script PATH prerequisite distinguishes a missing
PATH from an explicit empty or restricted value. Native Bun 1.4.4 preserves the
explicit suffix but injects its own temporary Node proxy. The portable dispatcher
keeps deliberate guest restrictions and only supplies `/bin:/usr/bin` when PATH
is absent. This addresses the Vite worker's immediate Node ENOENT/504 branch,
not its separate optimization delay. The explicit-PATH Vite control still
exceeded the unchanged 90-second deadline. No Vite app pass is established.

Two unchanged upstream failures need separate work:

- The resolver does not implement root overrides. At upstream lines 1673-1710,
  `selector-fits` declares `<2.0.0` and the matching override
  `selector-fits@^1.0.0` requests `0.5.0`. The resolver installs `1.0.0`.
  Invalid selector rows pass only because overrides are ignored. Follow
  `Resolver::resolve`, `children` and `target` in
  `crates/bunwasm-runtime/src/install/resolve.rs`. Add selector intersection
  using Bun's parser, reject selectors with skipped/overflow tokens, and apply
  overrides to root and transitive edges. Persist override metadata and
  invalidate affected pins so changed overrides cannot bypass frozen-lock
  checks. `install/mod.rs::lockfile`, `write_lock` and production `same_lock`
  currently omit that metadata. Keep upstream tests frozen and add local
  registry controls for initial, repeated and changed frozen installs.
- The seeded range differential still accepts overflowing numeric components
  after wildcards. Seed `1936026998` includes
  `Bun.semver.satisfies("2.0.0", ">=2.*.18446744073709551616+2") === true`
  while node-semver returns false. This is inside the patched upstream semver
  parser, outside the install adapters. The full failures and additional
  examples are in `before-upstream-quickjs-logs/cli/install/semver.test.ts.log`
  under the report directory. Do not restore a collection failure or relax the
  differential assertion to hide it.

Reproduce on each engine with current artifacts and the canonical shared queue:

```sh
source env.sh
bun /work/platform-production/heavy/current/run.js --class light semver-install -- \
  scripts/bun-suite.sh --engine jsc --network loopback --jobs 1 \
  --suite "$PWD/vendor/bun" \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-semver-package-manager.json cli/install/semver.test.ts
```

The runner snapshots the clean source reference into disposable copies. It does
not edit upstream source or execute tests in the shared reference checkout.
JSC must pass `check_jsc_inputs_stamp` in the consumer's source and environment;
a hosted pass or mismatched local prebuild is not a waiver.

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

Status: Resolved. Public constructors now carry the Node error codes while
preserving constructor identity, subclassing and internal port brands. Timer
fairness was already fixed by `63aae2264` through a bounded immediate snapshot.
`worker-port-constructors` and `worker-port-timer-fairness` cover both contracts
independently. The observations
below are historical.

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

Status: JSC constructor fixed. Cross-guest sharing is blocked on an engine and
process-model decision for the owner.

`tests/esbuild/run.mjs`, with `ESBUILD_CHECKS=sync.cjs`, still has no fully passing
engine run. Its four synchronous APIs need a shared buffer between the caller and
worker. QuickJS and the browser engine stop in `worker_codec.ts` with
`DataCloneError`. JSC stopped earlier, at esbuild's `lib/main.js:1941` with
`SharedArrayBuffer is not defined`: our JSC never set the
`useSharedArrayBuffer` option that native Bun sets in `ZigGlobalObject.cpp`.
`bunjsc_create_context` now sets it, so JSC has the constructor like the other
engines and reaches the same `DataCloneError`. `tests/fixtures/shared-array-buffer`
checks construction, views, `slice` and the refused send on every engine.

Two engine gaps remain inside a single guest. Our QuickJS build has no `Atomics`
global at all (`typeof Atomics === "undefined"`), and a growable
`SharedArrayBuffer` throws `TypeError: growable SharedArrayBuffer requires SAB
allocator hooks`; QuickJS-ng needs its atomics configuration and allocator hooks for
both. JSC now rejects resizable backing stores at the WASI allocation boundary with
an ordinary catchable allocation error. Fixed SharedArrayBuffer remains native.
`tests/jsc-embedding/growable-memory` checks rejection and subsequent fixed
allocation. Its blocking embedding gate uses the linked JSC guest and verifies
source, archive and artifact receipts. Supported growable backing stores remain
future work. Do not run the old unsupported allocation path for a baseline.

Real sharing cannot be added in the codec. Each guest is a separate wasm instance
with its own linear memory, and QuickJS and JSC keep SharedArrayBuffer storage in
that memory, reached by ordinary loads and stores from C. Two guests can only see
the same bytes if the storage lives in memory both can address: either an imported
shared memory that the engines' C code reaches as a second memory (clang has no
general support for that), or all guests of a process tree running as threads of
one shared linear memory (wasm threads, a different process model from Waffle's
one-instance-per-process). Copying the bytes would not be sharing, and forcing
esbuild onto its other backend is excluded. The owner needs to choose whether to
pursue a threaded guest model before this item can continue.

`WebAssembly.Module` cloning also stays unsupported. In-guest modules are compiled
by wasmi from bytes the adapter does not retain, and the browser engine's modules
are native V8 objects whose bytes cannot be recovered, so neither can be sent as
the bytes a receiving guest would need.

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

Status: Resolved. Waiting guests now wake on the event instead of a timer.

On main `d48dc3d2`, `test-worker-message-port-message-before-close.js` (10,000
sequential cross-guest port round trips) timed out at 30 seconds on every engine,
not only the browser engine. A 200-round-trip probe (parent and worker echoing over
`parentPort`) measured the cause: about 10.3 ms per round trip on QuickJS and JSC
and 25.8 ms on the Node-host browser engine, against 0.01 ms in native Bun. Those
are fixed wait intervals, not work:

- The native host's `procPoll` (`crates/bunwasm-host/src/process/mod.rs`) re-checked
  its subscriptions in a 10 ms sleep loop. It now reads the guest's `Notify`
  generation before checking and waits on its condition variable, which pipe wakers
  and child completion already bump. Changes that do not bump it (cancellation,
  write space) keep the 10 ms rescan bound.
- The browser engine's loop (`web/src/engine-host.js`) rescheduled itself every
  25 ms while the program only waited on I/O. It now also arms `Atomics.waitAsync`
  on the process wake word that Waffle pipes and child events publish on, read
  before stepping I/O so a change in between is not lost. The 25 ms rescan remains
  the fallback, and the only path where `Atomics.waitAsync` is missing. The Node host
  passes its process client's wake word; the browser executor passes Waffle's
  `runtimeState.wake`.

After the change the same probe takes 0.24 ms per round trip on QuickJS and JSC and
0.92 ms on the browser engine, and the upstream file passes on all three engines
with `scripts/bun-suite.sh --node-parallel --jobs 1 --timeout 30 --network loopback`.
The earlier "four-millisecond watch interval in `web/src/subprocess.js`" no longer
exists; that file was replaced by the process broker.

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

Status: Resolved by main. `worker_threads` loads again since guest workers landed
(#37), so the shared harness at `test/js/node/test/common/index.js:34` collects.
On main `d48dc3d2` plus the JSC buffer-transfer change, the fixed selection in
`docs/bun-test-suite/stream-adapter-files.txt` gives 21 passes and one skip on
QuickJS and the Node-host browser engine, and 19 passes, one skip and two failures
on JSC (`scripts/bun-suite.sh --node-parallel --jobs 1 --timeout 15 --network
loopback`). The skip is `test-stream-readable-to-web.js`, which reports `missing
crypto` because `process.versions.openssl` is absent. Both JSC failures are
`SharedArrayBuffer is not defined`, handled under shared memory above. The round-5
records in `/work/reports/bun-wasm-streams-round5-2026-10-16/` can be removed.

### Native stream construction overhead

Status: Resolved. Completion records are now allocated lazily.

`construct` in `web/src/native-stream-state.ts` used to give every bridged stream a
closed promise, its resolvers, a rejection handler and a `WeakRef` up front. Only
Node's `finished()` reads that promise (`kIsClosedPromise`), and most streams never
reach it. The promise and resolvers are now made on first read, a settlement that
happens first is recorded and applied then, and the `WeakRef` is made when the
record first joins a session or the poll set. Eager controller capture, pre-start
abort propagation, native brands and both Transform ports are unchanged.

`node scripts/test-native-stream-interop.mjs --benchmark` now reports, for native
streams and for the bridge in the same page, the median of seven runs of 10,000
create/close/cancel cycles after three warm-up runs. For the table below the same
experimental headless measurement ran on five fresh pages per variant, in fixed
native/eager/lazy order, with the bridge source from before and after this change.
Other jobs were running on the PC. The medians were:

| Browser | Native | Eager bridge (before) | Lazy bridge (after) |
| --- | --- | --- | --- |
| Chromium 156 | 16.3 ms | 42.7 ms | 37.7 ms |
| WebKit 27.2 | 19 ms | 62 ms (31-67) | 30 ms (28-30) |

These timings cover only this 10,000-cycle workload. They do not establish a
general 2x construction or application speedup. No quiet, counterbalanced run was
recorded.

The direct host-source browser gate (`node scripts/test-native-stream-interop.mjs`)
now includes eight completion controls in TypeScript, alongside the existing 73
cases. They check lazy allocation, cached promise and WeakRef identity, and late
success, error, cancellation, asynchronous abort, and Transform completion. Falsy
rejection reasons keep their exact identity. The eager parent fails the allocation
control. Deleting settlement replay fails the late-promise controls while the old
73 cases still pass. CI runs these controls through `scripts/test-web-host.sh --browser`.

Earlier guest fixture and adapter results used a retained binary whose whole-source
identity is not proven. These host-only checks do not endorse that binary, and no
guest rebuild is needed for this coverage change.
The round-5 log in `/work/reports/bun-wasm-streams-round5-2026-10-16/` can be
removed with the census records above.

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
especially Waffle `fs/shared.ts`, `fs/client.ts` and `fs/backend.ts`.

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

## Wasmtime memfd sealing startup failure during the API gate

Status: Approved. Reproduce before changing the launcher or Wasmtime.

The HTMLRewriter/X509Certificate lane observed one launcher startup failure in the
full JSC fixture gate on 2026-10-17. `net-route-leading-slash` printed no guest output
and failed before executing its route assertions:

```text
bun-wasm: cannot add seals to the memfd: Device or resource busy (os error 16)
```

The same run passed 200 fixtures, including the new HTMLRewriter and certificate
fixtures. QuickJS passed all 201 fixtures. The launcher uses Wasmtime 39.0.2, and
`crates/bunwasm-host/src/main.rs` loads the guest through `Module::from_file`.
Neither the launcher nor the route implementation changed in this lane. The
observation does not establish a guest networking or API failure.

Start with a bounded repeat of the unchanged fixture, using a private host build
and target directory through the heavy wrapper:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
CARGO_TARGET_DIR=/work/tmp/bun-wasm-own-target scripts/test.sh --no-build \
  --engine jsc net-route-leading-slash
```

Build `bunwasm-host` into that target before running the command. Keep the exact
wasm, launcher and cache settings in the reproduction. If it recurs, trace the
Wasmtime code-memory memfd creation and sealing path and compare cache-enabled
and cache-disabled controls. Do not add retries to the fixture or launcher.

The original full gate is retained in
`/work/reports/bun-wasm-htmlrewriter-x509-2026-10-17/round1/gate-jsc.log`.
The coordinator owns that evidence until the startup failure is reproduced or
ruled out. Final gate outcomes for this lane are recorded separately in its PR.

## HTMLRewriter lifetime and intrinsic storage parity

Status: Approved. Indexed prototype accessor interception is resolved. Lifetime
and abandoned-stream checks remain Approved.

The 2026-10-17 HTML/X509 lane adds the parser, handlers, async Response rewriting,
streaming readers and Node certificates. Its [measurement](../docs/bun-test-suite/htmlrewriter-x509.md)
records 9/10/10 fully passing files in the 21-file QuickJS/JSC/browser selection.
The lifecycle file remains partial, with 29/12, 19/14 and 24/25 observed pass/fail
counts respectively. QuickJS and JSC reach the unchanged 15-second file limit.
No private heap counter has been filled in to make these tests pass.

Reproduce the unchanged file on each engine through the heavy wrapper:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
scripts/bun-suite.sh --engine quickjs --jobs 1 --timeout 15 --network loopback \
  --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --output /work/reports/bun-wasm-own-html-lifetime/quickjs.json \
  --log-dir /work/reports/bun-wasm-own-html-lifetime/quickjs-logs \
  js/workerd/html-rewriter-leak.test.ts
```

Start with the cases named `never-settling handler promises are abandoned and
release their parked state`, `cancelling the output reader from inside a handler
releases the pipe`, and `an indexed accessor on Array.prototype never sees a
handler`. Separate HTTP body buffering from parser cancellation in the network
case. It waits for the first HTML handler before the server emits its second
chunk, so a host that buffers the whole HTTP body deadlocks before rewriting.
Do not classify that timeout as a demonstrated parser lifetime leak.

Inspect `Rewrite.asyncStep`, `stream`, `buffered`, and `close` in
`crates/bunwasm-runtime/src/js/html_rewriter.ts`, plus the parser-session table in
`src/html_rewriter.rs`. The async wrapper awaits an assimilated handler promise;
unreachable never-settling promises do not yet trigger native-style abandonment.
Private handler and synchronous output arrays now append own data properties,
so indexed prototype accessors cannot intercept registrations or output chunks.
`html-intrinsic-storage` reproduces both paths. Use real weak references and
owned native-state measurements for the remaining lifetime work; neither
zero heap counters nor a clean exit alone proves release.

Keep the full HTML file's direct-stream collection failure separate. Other newly
reachable files need TLS root certificates, TLS server support, private
`bun:jsc.serialize`, or `sslCtxLiveCount` in `bun:internal-for-testing`.
These are not remaining missing-HTMLRewriter or missing-X509Certificate exports.

Exact results and logs are retained in
`/work/reports/bun-wasm-htmlrewriter-x509-2026-10-17/verified/after-*.json` and
`after-*-logs/`. The coordinator owns that evidence until the follow-up is
reproduced and independently reviewed.

## Full fixture gates after the process-signal integration

Status: Approved. Runtime track owns the subprocess/error contract follow-up.

PR #41's review-fix branch, after merging main through `b7cf06cd` and rebuilding
the native launcher plus all three guests, reports **202 passed, 2 failed** on
each engine. Both new HTML/X.509 review fixtures pass. The failed fixtures are
`node-misc` and `pipe-closed-output`; the earlier pre-PR-33 build passed all 201
fixtures then present.

`node-misc` prints `child_process.spawn ENOENT: false` and
`Bun.spawnSync unsupported: false`, where its manual expectation has `true`.
Inspect `tests/fixtures/node-misc/index.mjs`, the calls of `spawn("ls")` and
`Bun.spawnSync({ cmd: ["ls"] })`, against the new disabled-host subprocess error
contract. No HTML or certificate API runs in that fixture.

`pipe-closed-output` observes SIGPIPE exit 141 instead of 1 in its unhandled
stream probes. Its Node-host batch probe also exits 141 without the expected
output. Inspect `crates/bunwasm-runtime/src/js/bootstrap.js::handleBrokenPipe`,
which raises signal 13 for escaping EPIPE, together with callback delivery and
signal disposition in the host. Compare native Bun/Node before changing the
fixture's expectations. The same failures recur in the first QuickJS gate and
the subsequent complete three-engine batch; the API fixes do not touch these
paths.

After building a matching launcher and guests into private targets, reproduce
through the heavy wrapper with:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
scripts/test.sh --no-build --engine quickjs node-misc pipe-closed-output
scripts/test.sh --no-build --engine jsc node-misc pipe-closed-output
scripts/test.sh --no-build --engine browser node-misc pipe-closed-output
```

Exact commands, source heads and logs are retained under
`/work/reports/bun-wasm-htmlrewriter-x509-review-2026-10-17/`.
`remaining/gate-{quickjs,jsc,browser}.log` contains the full gate diagnostics.
The coordinator owns this evidence until the runtime follow-up is reproduced
and the full gates pass. No assertion or runtime behavior was changed to hide
these failures in the HTML/X.509 lane.

The same review run's first full web gate hit a transient EADDRINUSE at the
subprocess helper's fixed default port 4183. Concurrent test callers should set
`BUN_WASM_TEST_PORT=0`; `web/tests/playground.mjs::serve` already supports it.
The lane reruns the full web gate with that setting and retains both logs rather
than terminating another job's server. See `remaining/gate-web-free-port.log` in
the same report.

The free-port full web recheck reaches `webkit browser atomic-transfer` and
fails at `web/tests/browser-workers.ts:27` with `atomic transfer attached`,
followed by `TypeError: Importing a module script failed.` and guest exit 1
instead of 0. Chromium and WebKit's QuickJS/JSC worker checks pass first. The
failure occurs in `tests/fixtures/worker-review/cases.ts`, without invoking HTML
or certificate APIs. The worker track owns isolating it against native Bun and
checking WebKit module/Blob URL lifetime. Its exact log is
`remaining/gate-web-free-port.log:1100` in the report above. HMR still passes all
six Chromium/WebKit engine runs. The lane leaves this gate failure visible.
## Framework follow-ups after exit provenance, 2026-10-17

Status: Approved. Vitest events export resolved by the async emitter adapter.
Other framework investigations remain Approved.

The shared `ws` require-dispatch failure and Vite's stdin-triggered shutdown are
fixed. Vanilla installs, renders, reloads source edits and builds on QuickJS,
JSC and browser. React and Vue pass all browser-engine stages. The current
90-second replay records 32/51 passing stages. [The exit report](../docs/app-matrix/exit-provenance.md)
separates current integration outcomes from earlier checkpoints. Preserve the
passing controls when following up.

Reproduce with a rebuilt private launcher through the heavy wrapper:

```sh
scripts/app-matrix.sh --apps=vite-react,vite-vue,sveltekit,astro,vitest \
  --engines=quickjs,jsc,browser --hosts=native --timeout=90 \
  --cache=/work/cache/bun-wasm-app-matrix \
  --launcher="$CARGO_TARGET_DIR/release/bun-wasm" --output=<fresh-directory>
```

The report destination is `/work/reports/bun-wasm-silent-exits-2026-10-17/`.
`landing-matrix/results.json` retains exit codes, signals, deadlines, guest exit
records and browser request failures. Current source is `0c154d04`, including
main through `390bda6d` and the runtime track's process, pipe and signal changes.
The earlier `scheduler-matrix/results.json` at `e4b4ea0f` remains historical
evidence.

- **React and Vue optimizer requests.** QuickJS and JSC dev stay alive but leave
  optimized `react.js`, `react-dom_client.js` or `vue.js` requests pending until the
  deadline. No browser error or HTTP failure is recorded. Inspect the optimizer
  context and esbuild service replies; a deadlock or a performance cause is not
  established by this bounded observation. A 300-second replay completes
  QuickJS dev/reload/build; JSC instead receives HTTP 504 `Outdated Optimize Dep`
  for both React dependency URLs. The 180-second scheduler replay reproduces
  that distinction. Preserve the longer-run evidence alongside the 90-second
  failures; do not call the QuickJS result a permanent deadlock. Vue passed at
  the earlier checkpoint but hits the same pending-request deadline now.
- **JSC React and Vue builds.** Current builds hit the deadline after 22 and 8
  transformed modules respectively, without guest exit records. Historical
  `scheduler-matrix/vite-react-jsc-build.log` contains `JSLock::unlock` through
  `JSObjectSetProperty` and `engine_jsc::from_val`. The current timeout does not
  reproduce that trap or prove it fixed. Keep package sources unchanged and
  investigate native value lifetime, lock ownership and GC during conversion.
- **SvelteKit completion.** Current QuickJS build reaches the deadline after
  `179 modules transformed` and `rendering chunks`. JSC dev reaches ready,
  reports `vite.config.js changed`, then times out. JSC build times out with no
  output. Browser dev repeatedly restarts config and loses its SSR `fetchModule`
  transport, then remains alive until the deadline. None records a guest exit.
  Trace which file or config dependency causes the restart and why in-flight
  optimizer work survives service shutdown. A temporary watcher trace saw no
  direct notification for `vite.config.js` itself.
  Historical QuickJS builds drain with all loop counters zero but no output.
  Historical JSC dev faults in `JSRopeString::resolveToBufferSlow<char16_t>`
  through `resolveModule`, with an out-of-bounds access at `0x6f6e6e69` in
  `0x4640000` bytes of linear memory. That stack differs from React's JSLock
  failure. Start with module resolve string/value lifetime around
  `engine_jsc.rs:302`; no cause is proved. Historical browser dev exits on an
  unhandled esbuild `The service was stopped` rejection with live handles.
  Do not assume these engine outcomes have one cause.
- **Astro module loading.** The original QuickJS circular `Fragment` binding and
  JSC/browser missing `Http2ServerResponse` export are reached again after fixing
  builtin dispatch. Their plain-message errors are now retained by classification.
- **Vitest events adapter.** Both configured pools stop at the missing
  `EventEmitterAsyncResource` export on every engine, before a worker pool starts.
  The async emitter adapter now exports it and runs listeners in the resource's
  creation context, including promise continuations. `events-async-resource`
  covers ESM/CommonJS identity, subclass construction, errors and context
  restoration. Rerun the pinned Vitest application to classify its next blocker.

The same investigation reproduced and fixed callback starvation independently
of the framework outcomes. A recurring immediate starved I/O on QuickJS/JSC
and due timers on every wasm engine. The ready-batch and I/O-turn regressions
now pass on all engines. This does not resolve the React optimized-dependency
504 or either native JSC fault; their app-level follow-ups remain approved.


## JSC native-output buffer transfer

Status: Resolved. The JSC C API's `JSObjectGetTypedArrayBytesPtr` and
`JSObjectGetArrayBufferBytesPtr` call WebKit's `ArrayBuffer::pinAndLock()`, and
`isDetachable()` is false for a locked buffer. Every buffer the JSC adapter filled
(`engine_jsc.rs::uint8_array`) or read (`bunwasm-jsc::Js::bytes`) therefore stayed
non-detachable for good: native outputs such as `TextEncoder.encode`, `readFileSync`
and `Buffer.from(string)`, and JavaScript buffers passed to `TextDecoder.decode` or
`writeFileSync`. Native Bun 1.4.2 transfers all of them.

`bunjsc_buffer_bytes` in `crates/bunwasm-jsc/cpp/helpers.cpp` now returns the view's
or buffer's bytes without pinning; both callers copy or fill them before any
JavaScript runs, so nothing can detach the storage meanwhile. No locked storage is
force-detached. `tests/fixtures/native-output-transfer` transfers native outputs,
native inputs, an offset view and a JavaScript-created buffer on every engine;
on a JSC build before the fix it stops at the first case with `DataCloneError:
ArrayBuffer is not detachable`. `transpiler-review` transfers its `TextEncoder`
buffer directly again, and the worker codec and WebAssembly adapters no longer
copy bytes to keep them detachable.

## Browser immutable promise limitations

Status: Approved. Ordinary and configurable constructor/species cases are implemented in PR #59. Remaining immutable cases need a host-engine capability if they become required.

`web/src/promise-reactions.ts` temporarily installs an own safe constructor descriptor, calls the captured native reaction operation, then restores the original descriptor in `finally`. Its private data-only species object avoids patched global species getters. This introduces no wrapper promise or additional reaction job. Ordinary frozen promises use the native method when descriptor inspection proves the inherited constructor/species safe. Writable non-configurable constructors and configurable constructors on non-extensible promises are supported.

The browser limitations are a non-configurable constructor accessor; a read-only unsafe constructor/species combination; a non-extensible promise with unsafe inherited constructor/species; and native promises whose modified prototype chain no longer includes Promise.prototype. Constructor inspection never calls these user getters. The first three cases report a named observation error. An already rejected original can remain unhandled because no rejection handler can be attached through the public method. A fresh wrapper resolves through the original public `then`, which still reaches the immutable constructor before attaching a handler. Changing the wrapper's descriptor cannot change that lookup on the original.

`test-promise-intrinsics` retains immutable constructor/species, frozen inherited constructors on non-extensible promises, and missing-prototype-chain cases as browser-only TODOs, while QuickJS/JSC execute the same checks using native reaction APIs. The browser diagnostic test uses a rejection handler attached before locking the constructor to verify the message and zero getter calls. Reproduce via `scripts/test.sh --engine browser test-promise-intrinsics`; inspect the TODO lines rather than treating them as passing coverage. Helper units cover descriptor restoration, global species patches, ordinary frozen promises, exact fulfilled identity and job ordering. Evidence and a fresh-wrapper impossibility control are retained in `/work/reports/bun-wasm-small-causes/browser-constructor-fix/`.

The coordinator owns any future embedding capability and retained evidence cleanup after re-review. Do not filter rejection notifications to hide these limitations. Preserve the existing observer identity and falsy-rejection controls.

## WebKit OPFS reload after closing its owner

Status: Approved for the Waffle filesystem track. Capture the failure state before choosing a fix.

During PR #67 verification on main `25d437af`, `scripts/test-web.sh` failed once at
`web/tests/browser-filesystem-lifecycle.ts:249`: after closing the OPFS owner tab
and reloading the blocked tab, `state().ready` was `false` instead of `true`.
The unchanged isolated WebKit rerun and the OPFS phase of the next full run passed.
The installed Waffle pin was `95ebf29a96cb0c967924071e4c68c6b02bf3ff5a`.
Reproduce with `bun web/tests/browser-filesystem-lifecycle.ts webkit` through the
heavy queue, using the installed Playwright path. Capture `state().error` and
filesystem teardown acknowledgements around owner close. Waffle `fs/opfs.ts:108`
refuses an unavailable writer lock; `fs/opfs.ts:187` closes its owner. A delayed
lock release is a candidate, not a confirmed cause. No runtime change or retry
was added. Evidence is in `/work/reports/bun-wasm-web-worker/waffle-final/`;
the coordinator removes it after PR acceptance and this observation is triaged.

### Node HTTP upload dispatch, 2026-10-18

Status: Approved follow-up. Keep separate from Bun response streaming.

`serveHttp` in `crates/bunwasm-runtime/src/js/net.js` waits for the complete
request before calling an ordinary Node HTTP listener. A client that writes
`first` and waits for a response before calling `end()` stalls. Native Bun
prints `handler false`, `chunk first false`, and `received` for the retained
upload reproducer. All three original guest engines stall. Evidence and the
reproducer are under `/work/reports/bun-wasm-http-scoreboard-20261018/`.
The coordinator owns that evidence until this follow-up is accepted.

Dispatching headers early also requires handling an ignored body larger than
IncomingMessage's high-water mark. The retained `ignored-upload.ts` sends a
128 KiB POST followed by a GET on one socket. Native Bun and unchanged main
print `/ignored`, `/next`, `two responses`. An early-dispatch candidate stranded
the second response. Its automatic-drain refinement then reduced the unmodified
QuickJS gzip file from 62 observed passes to 33 before the file deadline.
The candidate is excluded from the response-streaming PR.

The two reproducers are retained in that report's `repro/` directory. From an
owned worktree with its guest and launcher built, run:

```sh
source env.sh
repro=/work/reports/bun-wasm-http-scoreboard-20261018/repro
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm dist/bun.wasm --dir "$repro"::/ run /upload-stream.ts
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm dist/bun.wasm --dir "$repro"::/ run /ignored-upload.ts
```

The coordinator retains these two small fixtures until the upload-dispatch
follow-up is accepted or explicitly retired. The accepted empty-FIN close cycle
is fixed separately by `net-tcp-empty-fin`; preserve that control.

Start from unchanged Node dispatch. Reproduce both upload cases, preserve
`req.complete`, explicit socket pauses, response close policy and connection
reuse, then measure `node-http-req-complete.test.ts`,
`node-http-req-socket-pause.test.ts`, `node-http-server-close-drain.test.ts` and
`js/web/fetch/fetch-gzip.test.ts` on every engine. No process-layer changes were
made. Keep the child larger-than-1-GiB gzip case distinct from protocol behavior;
its direct original and changed controls both hit the guest memory limit with
exit 134. Do not skip it or change its upstream assertions.

### Early-response keepalive control, 2026-10-18

Status: Approved follow-up. Pre-existing on main; excluded from the Bun response
streaming change.

The JSC census showed 32 versus 31 observed passes in
`js/web/fetch/fetch-keepalive.test.ts`. The difference was the early 200 response
to a 64 MiB POST. A following GET sometimes reuses that connection and receives
the test server's sentinel status 299 instead of the expected status 200.
Five clean runs of the unmodified focused upstream test pass once and fail four
times on both unchanged main `684da1f0` and the PR guest. They use the same restored
native launcher, source snapshot, preload, environment and loopback isolation.
The runtime and native-client sources on that main commit match baseline
`2ea5c62f`. The guest hashes are recorded in the retained control report.

Run the upstream test with `-t '200 while a 64 MiB byte body'` through a rebuilt
JSC guest and native launcher. Preserve the upstream preload and the suite's
private loopback namespace. The exact executable command is retained as
`early-upload-control/upstream-control.sh` under
`/work/reports/bun-wasm-http-scoreboard-20261018/`. Each run has its own temporary
directory, log and exit status. The paired direct diagnostic records bytes
received and the declared length; both guests reach both connection outcomes.

Changing the native request body from a byte vector to a sized blocking body
did not fix the focused failure. That experiment is reverted. Inspect native
`crates/bunwasm-host/src/net/fetch.rs` and reqwest's connection reuse after early
responses before proposing a fix. Do not change guest response scheduling or
weaken the upstream assertion to mask the observation. The coordinator owns the
small reproducer and control evidence until this follow-up is resolved or retired.

### Process-runtime web gate blocker from HTTP review, 2026-10-18

Status: Resolved by landed PRs #92 and #94. The failures below are historical
evidence, not current blockers. PR #80 does not change process integration.

The full web gate cannot instantiate either the pre-review merged-main baseline
`c8244547` or HTTP review guest `af670576` through `web/scripts/run.ts:42`. Both exit 1 with
`TypeError: unsupported import runtime_proc.signal (function)` before the script
runs. The shim constructs Waffle's `Wasi` without a `runtime_proc` namespace.
Its source is also unchanged on main `7bc7ba37`. Reproduce from an owned worktree
with its rebuilt QuickJS guest:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
cd web
bun scripts/run.ts ../dist/bun.wasm -e 'console.log("import control")'
```

The same failure blocks all seven CLI network fixtures in both table and import
modes. The three HTTP review regressions pass through the native launcher on all
engines. The missing import precedes their HTTP code. The process-runtime lane
should migrate the standalone shim to the current process adapter and preserve
both host-slot modes. Do not add a fake signal handler to make instantiation pass.

The same web run also reports `TypeError: #<p> is not an integer typed array` from
`Atomics.load` while stopping a foreground browser process. The stack reaches
`web/tests/foreground.ts:17`, `runForeground:39`, `playground.mjs:139`, and
`browser-install.mjs:37`. This second failure has not been isolated against a
baseline browser build. Reproduce with `scripts/test-web.sh`, using the installed
Playwright path and an explicit temporary root. Inspect the process signal state
passed to the runtime's `kill` implementation before changing HTTP code.

Exact paired import commands, hashes, exit statuses and the full web log are
retained in `/work/reports/bun-wasm-http-scoreboard-20261018/review-r1/` as
`import-control.*`, `import-control-before.*`, `import-control-after.*`, and
`gate-web.log`. The coordinator owns this evidence until the process-runtime
follow-up is resolved or retired. No process-layer fix, retry or skip is included
in PR #80.

## Native standard-stdio close parity

Status: Approved, deferred. The native runtime/descriptor track owns this work;
PR #94 does not change native close behavior.

At source `8c740de9a385a05693f21d96fefec8d3f2556a80`,
`crates/bunwasm-runtime/src/natives.rs:717-721`, `close_descriptor` returns success
for fd 0, 1 or 2 without calling libc close. The same guard exists in the PR base
`3f071e7107a2133d06e89c80a4fa7c80c5ad470c`. Nonstandard descriptors do close.
This is source-confirmed pre-existing behavior, not an observed failure in the
103-pass native host run. No destructive stdio-close control was run in a shared
process. Evidence is retained in
`/work/reports/runtime-continuation-20261020/bun-integration/remaining-native-stdio.md`.

Reproduce in a separate fresh native subprocess for each fd 0, 1 and 2. Compare
native Bun with a source-matched native runtime build, recording both versions
and the candidate source/artifact hashes. Give the child a separate inherited
result fd, such as fd 3, which it must never close. Keep stdin/stdout/stderr as
separate pipes and report results only through the result fd. After the first
close succeeds, require the following to report `EBADF` independently:

- a second close;
- fstat;
- a nonempty read on the closed input descriptor;
- nonempty write and writev on each closed output descriptor.

Preserve Node/Bun's public zero-byte read short-circuit. In a fresh control with
no descriptor closed, verify each operation works and aliases retain the same
open-file-description behavior. Do not close the runner's own standard streams.
Remove or replace the early-return guard only after inspecting buffered output
aliases and runtime ownership. Run equivalent browser/WASI subprocess controls
with an explicit inherited result-descriptor mapping, not a filesystem preopen
mistaken for the result fd.

Acceptance requires source-matched native and browser/WASI controls, repeated
close/fstat/nonempty I/O reporting `EBADF`, intact zero-byte read behavior and
buffered alias output, and no new unowned descriptors/processes. Keep this entry
until those controls and independent review pass. The implementing lane owns
all probe processes, result pipes/files and private build scratch on every exit;
the runtime coordinator owns retained evidence until the follow-up is accepted,
then removes it. Preserve shared targets and caches.
