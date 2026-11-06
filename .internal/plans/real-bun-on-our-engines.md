# Real Bun on our engines

Status: Approved (owner, 2026-10-15)

Hermes remains parked under the November 1 owner decision; its retained `c36356f4` engine has a documented empty-handler Proxy `isSealed`/`isFrozen` limitation, accepted narrowly for PR 482 with no engine fix or restart in scope.

## Goal

Run as much of Bun's own code as possible, on all three engines (QuickJS, the browser's engine,
JavaScriptCore in wasm). Bun Lite and "full Bun" are one runtime: the more of Bun's code we can
run engine-independently, the fewer polyfills we keep. JSC additionally gets Bun's C++ bindings
where they help.

## Tracks

1. **Bun's JavaScript builtins.** `vendor/bun/src/js/` (node:*, parts of Bun.*, internal modules)
   is Bun's own TypeScript. Generate it with Bun's codegen (`docs/real-runtime-spike.md`), give it
   the `$`-intrinsics and native hooks it calls, implemented once over our `Engine` trait, and
   replace our hand-written modules with Bun's, module by module, measured on Bun's test suite.
2. **Bun's Rust runtime over our engines.** Bun's Rust runtime talks to JavaScript through
   `bun_jsc`. Add a backend for it over our `Engine` trait so Bun's real Rust implementations
   (fs, Bun.file, HTTP parsing, …) run on every engine. Start with one module end to end.
3. **JSC-only native layer.** On the JSC engine, Bun's C++ bindings (spike: first milestone is
   Bun's global object running console.log). Lower priority than 1 and 2.
4. **Compatibility campaign.** Keep fixing until every remaining failure in Bun's test suite is a
   documented platform limitation (or an explicitly "not worth it" item):
   - an app-compatibility matrix (real frameworks and servers, client and server in one tab) is
     the main scoreboard;
   - Bun's own test suite is the coverage gauge (`docs/bun-test-suite/`).

## Rules

- Prefer Bun's code over ours. A polyfill we keep needs a reason (no engine-independent Bun
  equivalent exists yet).
- No suite or fixture regressions on any engine; every module switch is measured before/after.
- Engine-specific behaviour stays behind the `Engine` trait.

## End condition

Every failing file in Bun's suite is categorised as a platform limitation or "not worth it",
with its reason, and the app matrix lists only failures with the same causes.

## Next after crypto, 2026-10-16

Status: Approved.

WebCrypto and Node key APIs remove the earlier `crypto.subtle.generateKey` rejection.
An integration of main `6f1e576`, PR 13 `eae65c7`, and the crypto branches now reaches
`TypeError: _promises.default.opendir is not a function` during Next 15.5.6 build.
The SWC unsupported-platform warning is earlier output, not the terminating error.

Next owner: implement `fs.promises.opendir` and the directory handle iteration/close behavior
needed by Next. Inspect the promise export registry in
`crates/bunwasm-runtime/src/js/node_fs.js`, which exports readdir but has no opendir.
Reproduce in an integration with PR 13 and the crypto PRs, after building the browser artifact:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
scripts/app-matrix.sh --apps=next --engines=browser --hosts=native \
  --cache=/work/cache/bun-wasm-app-matrix --timeout=90 \
  --output=/work/reports/bun-wasm-next-opendir \
  --launcher=/work/tmp/bun-wasm-target/release/bun-wasm
```

Run through the machine's heavy wrapper. The retained reproduction is
`/work/reports/bun-wasm-crypto-2026-10-16/next-after/next-browser-build.log`.
Installation passed; build exited 1 without a timeout; dev produced no diagnostic and start
was blocked by build. Registry replay had 71 requests, no misses and no errors. Cleanup passed.
The original matrix summary missed the bracketed error; its raw log and a corrected diagnostic
projection are retained. The parser has a regression test for that exact format.

## Compatibility follow-up after Web Streams

The following missing-global observations predate PR #8, which adds a limited
WebAssembly API. Preserve them as historical evidence. The Next lane owns rerunning
the combined branch to identify the remaining llhttp requirements.

Next 15.5.6 now loads past `TextEncoderStream` on QuickJS and JSC when the Streams
change is combined with PR #9. Its bundled undici requires a WebAssembly llhttp
parser, but the embedded engines have no `WebAssembly` global. The failure is in
`next/dist/compiled/@edge-runtime/primitives/load.js:5626` and the fallback at
line 5628, both `WebAssembly.compile(...)` calls. QuickJS dev reports
`ReferenceError: WebAssembly is not defined`; JSC dev/build reports an undefined
`WebAssembly.compile`; QuickJS build exits 1 with the same bracketed rejection.
This reproduced on the all-engine native app-matrix replay with no registry misses.
No missing Streams constructor appears in those diagnostics.

The next lane owns that WebAssembly capability gap. Reproduce with
`scripts/app-matrix.sh --apps=next --engines=quickjs,jsc,browser --hosts=native --timeout=90`
after PR #9 and the Streams change are present. Use an explicit fresh `--output`
and the built native launcher. Keep the browser's existing dynamic-import-method
rewrite failure distinct. Raw logs and provenance are in
`/work/reports/bun-wasm-web-streams-2026-10-16/next-integration/`, including
`next-quickjs-dev.log`, `next-quickjs-build.log`, `next-jsc-dev.log` and
`next-jsc-build.log`. The coordinator owns preserving the evidence until the
follow-up has reproduced it. See `docs/app-matrix/compatibility.md` for the replay command.

### Second-review combined replay

The Web Streams second-review replay includes main through PR #17. QuickJS and
JSC dev both reach `WebAssembly.instantiate` in
`next/dist/compiled/@edge-runtime/primitives/load.js:5630` and fail with
`LinkError: Unsupported WebAssembly export table`. The cause is the explicit
non-memory export rejection in
`crates/bunwasm-runtime/src/js/webassembly.js:136`; no missing Streams global is
reported. The WebAssembly follow-up should support llhttp's exported table
without removing or rewriting exports in the package fixture.

Both embedded-engine builds exit 1 without a diagnostic. Browser dev exits
without an HTTP response or diagnostic, and browser build retains
`SyntaxError: Unexpected token '.'`. These remain separate observations, not
proof of the same cause. All three installs pass and all production starts are
blocked by failed builds. Reproduce with the command above and a fresh output
directory. Exact rows, complete command output and the zero-miss offline registry
check are in `/work/reports/bun-wasm-streams-review2-2026-10-16/next-after/`.

### HTTP response chunk framing after the adapter census

Status: Done. PR #80, `c4794d69`, added incremental response framing and
forwarding. On 2026-10-23, the original unchanged
`js/node/test/parallel/test-webstreams-pipeline.js` exits successfully on
QuickJS, JSC and browser at main `d48dc3d2` with this lane's listener fix.
`net-http-response-framing` and `net-streams` also pass on all three engines.
The original mismatch below is historical, not an open follow-up.
Replay JSON and logs are in
`/work/reports/wave-20261022/bun-wasm/real-bun-followups/pipeline-*`.

The round-3 Web Streams fix replaces the minimal Node stream classes and fixes
HTTP source and request lifecycle integration. The unchanged Node adapter census
now reaches an HTTP data-chunk mismatch in
`test/js/node/test/parallel/test-webstreams-pipeline.js:215`. All three engines
receive `['helloworld']` instead of `['hello', 'world']`. This is a body-framing
observation; byte content is intact. Do not classify the entire file as passing.

`ServerResponse._send` in `crates/bunwasm-runtime/src/js/net.js` concatenates
response writes and sends Content-Length. `ClientRequest._send` reads
`res.arrayBuffer()` before pushing one response chunk. Investigate incremental
HTTP response framing and forwarding together rather than splitting a completed
buffer to satisfy this fixture. The HTTP/Web round-trip fixture and Node client
finish/destruction fixture pass on QuickJS, JSC and browser after the lifecycle
fix. A native Node control passes the unchanged upstream file.

Reproduce with `scripts/bun-suite.sh --node-parallel --engine quickjs --jobs 1
--timeout 15 --network loopback --output <fresh-results.json> --log-dir
<fresh-logs> js/node/test/parallel/test-webstreams-pipeline.js`, repeated for JSC
and browser, through the heavy-job wrapper. Exact all-engine diagnostics and
before/after provenance are retained in
`/work/reports/bun-wasm-streams-round3-fix-2026-10-16/` under
`http-final-*-logs/` and `final-after-*-logs/`. This is the consistent first
remaining failure after fixing the earlier `_read` error and request completion
hang. The compatibility track owns the framing follow-up and evidence removal
after reproduction.

### Browser-host child port release

Status: Approved, still open after the 2026-10-23 code audit. The isolated
`self-spawn-network` replay passes on all three engines, but that does not prove
that asynchronous worker termination precedes observable child completion.
Current main `d48dc3d2` pins Waffle `b20fad1`; its
`proc/supervisor.ts:complete` publishes exit before `stopHandle`. The Node
adapter in `web/scripts/node-spawn.ts` returns the worker termination promise
but supplies no network quiescence fence. The old `web/src/subprocess.js` no
longer exists. Reproduce the ordering deterministically before changing it;
do not classify a successful isolated retry as closure of the race below.

The Web Streams round-3 full browser gate observed one `self-spawn-network`
failure after an earlier full run passed that fixture. The child serves a
response and reports exit 143, but immediate parent rebinding fails with
`EADDRINUSE`. The failed port was no longer listening when checked after the
fixture process exited. No stream expectation was changed to hide this result.

Inspect `web/src/subprocess.js`, especially `kill()` and `reap()`. The Node host
worker's `terminate()` returns a promise, but `kill()` currently publishes child
completion immediately, before awaiting that promise. Confirm resource release
before making `child.exited` observable, with matching handling for the browser
worker implementation. Do not add a delay or retry to the fixture.

Reproduce through the heavy wrapper with `scripts/test.sh --no-build --engine
browser self-spawn-network`, then the full browser gate. The first observed
failure is in
`/work/reports/bun-wasm-streams-round3-fix-2026-10-16/final-gate-browser.log`.
The isolated retry and full rerun are retained alongside it. This is a
browser-host subprocess lifecycle follow-up owned by the compatibility track.

## Next browser follow-up, 2026-10-16

Track 4 continues with Web Crypto after the semantic import rewrite. Next 15.5.6 build,
with PR 9's runtime fixes included, now reaches the unsupported `crypto.subtle.generateKey`
stub in `crates/bunwasm-runtime/src/js/web.js:1277`. Dev still has no useful diagnostic;
start is blocked by build. See [the exact command and retained evidence](../../docs/app-matrix/compatibility.md#browser-import-parsing-follow-up).
The crypto algorithm and any later required operations still need a bounded reproduction.

### Bun native-consumer stream state coverage

The Web Streams round-3 run of the original 14 files under `js/web/streams/`
and `js/node/stream/` retains all four passing files on QuickJS and JSC.
Observed passes rise from 16 to 21 on each. Loading real Node stream state also
unblocks collection of `js/node/stream/web-stream-state.test.ts`; it now records
2 passes and 25 failures before the 15-second file deadline, rather than stopping
at collection. This is a bounded observation, not a fully passing state test.

That file checks Bun-specific native-consumer locking and inspection across
`Bun.write`, `Bun.serve`, subprocess stdin, HTMLRewriter and fetch. Examples show
expected `inspect: 'closed', locked: true` versus `inspect: undefined, locked:
false`; subprocess stream stdin also throws `Expected an ArrayBuffer or
ArrayBufferView`. Heap counters remain unavailable, so passing leak assertions
do not establish leak freedom. Implement the actual native-consumer contracts
and inspection support without fabricating private states or heap values.

Reproduce with `scripts/bun-suite.sh --engine quickjs --jobs 1 --timeout 15
--network loopback --output <fresh-results.json> js/web/streams js/node/stream`,
repeated for JSC, through the heavy wrapper. Exact per-file results are in
`/work/reports/bun-wasm-streams-round3-fix-2026-10-16/final-streams-*.json`,
paired with `streams-before-*.json`. The compatibility track owns this remaining
Bun-specific work and the evidence until follow-up reproduction.

### Round-3 combined Next replay

With main through PR #13, the Web Streams round-3 replay reaches the same llhttp
export-table rejection in QuickJS/JSC dev. Their builds and browser dev have no
useful diagnostic. Browser build now reaches missing
`crypto.subtle.generateKey`, beyond its former import-method syntax error. The
crypto lane owns that operation; the WebAssembly lane owns llhttp table support.
There are no missing Streams globals, registry misses or registry errors.
The [app-matrix record](../../docs/app-matrix/compatibility.md#web-streams-round-3-replay-with-semantic-imports)
links the exact artifacts and all 12 stage outcomes. PR #24's later WASI-host
merge has separate verification before this lane's delivery.
## TypeScript follow-up

Status: Approved, in progress on 2026-10-23. The old prerequisite PRs have
merged. Main already converted `path.js`, `spawn.js`, `array_buffer_sink.js`
and `function.js` with native contracts and emission checks. The JSONL/`node:test`
group converts `jsonl.js` and `node_test.js` to strict TypeScript with their UTF-8,
data-format and test-runner contracts in `src/js/runtime.d.ts`. It also empties
lines that held only erased types while preserving every remaining token's line
and column. The `string_decoder`/`node:url` group converts `string_decoder.js`
and `node_url.js` the same way, adds their `domainToASCII` and `node:querystring`
contracts, and adds the `runtime-ts-url-decoder` fixture. The remaining modules
below are still open. Generated/copied output must move through its generator,
not hand edits.

Convert the remaining runtime JavaScript to TypeScript in small module groups. Prefer replacing
our implementations with Bun's own builtin modules where available. Extend `src/js/runtime.d.ts`
with each native or engine contract used, keep strict checking enabled, and compare all three
engines before and after each group. Regenerate copied/generated files from their generators
rather than changing their output by hand. Measure each group's emitted bytes, not its
source: annotations inside a line still erase to spaces.

Group 1 verification after rebasing onto main `9a087474`: strict runtime
checking and 127 unit tests pass, including copied-buffer/lifecycle and generated
Function module-origin checks, plus positive/negative native contract probes.
Lint, project type checks and the duplicate gate pass. The six sink/import
fixtures pass before and after this group on QuickJS, JSC and browser, six passed
and zero failed per engine per run. All three guests were rebuilt from `963426a0`;
each after run also passes strict runtime checking and 127 unit tests. The first
build rejected another worktree's BoringSSL cache without changing it. A fresh
lane-owned cache passed preflight and was removed after the completed replay.
Evidence is in `types-group1-guests.log`, `types-group1-resume-guests.log` and
`types-group1-baseline-manifest.txt` under
`/work/reports/wave-20261022/bun-wasm/real-bun-followups/`.
This closes group 1 only; keep the overall section in progress.

The stack-capture and builtin-loader group converts the original adapters to strict
TypeScript. Its opt-in compact factory emitter preserves classic-script strictness;
other modules retain the existing blank-type-line erasure. Red-first source tests
cover the emitter. Completed same-source fixed/raw builds cover six guests, three
engine pairs, with all 30 stack-fixture receipts passing. Fixed-minus-raw Wasm sizes
are QuickJS -1,642 bytes, JSC -1,612 bytes and browser -1,667 bytes. The browser guest
ran under Node/V8, not a real browser. Compact adapter internal coordinates are not
preserved. Independent evidence is in
`/work/reports/wave-20261022/bun-wasm/review136-r3/`. This closes only this adapter
group; the overall TypeScript follow-up remains in progress.

The cookie/data-format/Intl group converts exactly `cookie.js`, `formats.js` and
`intl.js` to strict TypeScript against main `e0c85f29`. It preserves the original
runtime syntax and strict directives. Native data parsing and existing engine Intl
authority stay unchanged. Additive declarations describe the tagged data graph,
Temporal operations, byte conversion and YAML coercion. The CI-discovered
`runtime-ts-small` fixture joins the existing cookie, data-format, YAML coercion
and Intl fixtures without adding a native build. Verification records are under
`/work/reports/bun-wasm/ts-small-20261024/`.


The handwritten streams group converts only `streams.js` to `streams.ts` from
immutable PR140 source `ac43127c85addabed7e0c2a4883247ae074e858c`. Native decoder,
portable constructor and compression contracts are additive. Approved local
changes keep converted label/options in const locals and fail closed with a
TypeError on an impossible missing own descriptor. Host-native text constructors,
portable controllers, handles, byte flow and error identities stay unchanged.
The generated stream bundle and Node ports remain separate work. Web discovery
owns the wrapper/strict/AST suite; the existing native smoke owns the new
`runtime-ts-streams` fixture. This group remains under independent parent review.
Verification records are under `/work/reports/bun-wasm/ts-streams-20261024/`.


Small host-tool slice, 2026-10-24: `scripts/app-matrix/classify.mjs` becomes
strict `classify.ts` against main `9a39a9ad`. Only its imports and source identity
inventory change. Readonly row contracts retain caller fields; diagnostics,
stage boundaries and QuickJS-only reclassification stay unchanged. Focused runtime
and positive/negative type tests belong to `quality:probes`; ordinary scripts
checking owns the source. This delivers one host-tool slice, not the remaining
runtime conversion. Evidence is under
`/work/reports/wave-20261022/bun-wasm/reboot-20261024-0930/classify-ts/`.

Remaining files after the stack/builtin and cookie/data-format/Intl conversions:

- `crates/bunwasm-runtime/src/js/bootstrap.js`
- `crates/bunwasm-runtime/src/js/buffer.js`
- `crates/bunwasm-runtime/src/js/builtins.js`
- `crates/bunwasm-runtime/src/js/bun_console_constructor.js` (generated by `scripts/generate-bun-console.mjs`)
- `crates/bunwasm-runtime/src/js/bun.js`
- `crates/bunwasm-runtime/src/js/bun_sqlite.js`
- `crates/bunwasm-runtime/src/js/bun_tcp.js`
- `crates/bunwasm-runtime/src/js/bun_test.js`
- `crates/bunwasm-runtime/src/js/console_constructor.js`
- `crates/bunwasm-runtime/src/js/console.js`
- `crates/bunwasm-runtime/src/js/crypto_host_keys.js`
- `crates/bunwasm-runtime/src/js/crypto.js`
- `crates/bunwasm-runtime/src/js/crypto_keys.js`
- `crates/bunwasm-runtime/src/js/events.js`
- `crates/bunwasm-runtime/src/js/html_server.js`
- `crates/bunwasm-runtime/src/js/inspect.js`
- `crates/bunwasm-runtime/src/js/net_address.js`
- `crates/bunwasm-runtime/src/js/net.js`
- `crates/bunwasm-runtime/src/js/node_fs.js`
- `crates/bunwasm-runtime/src/js/node_net.js`
- `crates/bunwasm-runtime/src/js/node_stream_bindings.js`
- `crates/bunwasm-runtime/src/js/node_stream_core.js` (generated by `scripts/vendor-node-streams.mjs`)
- `crates/bunwasm-runtime/src/js/node_stream_internals.js`
- `crates/bunwasm-runtime/src/js/node_stream_web.js`
- `crates/bunwasm-runtime/src/js/process.js`
- `crates/bunwasm-runtime/src/js/streams_polyfill.js` (generated by `scripts/vendor-streams.py`)
- `crates/bunwasm-runtime/src/js/structured_clone.js`
- `crates/bunwasm-runtime/src/js/temporal.js` (generated by `scripts/vendor-temporal.py`)
- `crates/bunwasm-runtime/src/js/webassembly.js`
- `crates/bunwasm-runtime/src/js/web.js`
- `crates/bunwasm-runtime/src/js/websocket.js`
- `crates/bunwasm-runtime/src/js/ws_builtin.js` (generated by `scripts/generate-ws.sh`)

Found during the JSONL/`node:test` and `string_decoder`/`node:url` groups, not fixed there
because those groups keep behaviour identical:

- `node:test` called without a name fails. Native Bun 1.4.2 runs `test(function unnamed() {})`
  and `test({ timeout: 100 }, () => {})`. Our adapter passes the function or options
  object as the name, so `bun_test` throws `test expects a function as the second argument`.
  The fix belongs in `src/js/node_test.ts` `register`: accept an optional leading name and
  take the name from the function when it is missing. Add both calls to the
  `runtime-ts-node-test` fixture and regenerate its expected output with native Bun.
- `Bun.JSONL` token and separator parity is implemented in `src/js/jsonl.ts`, pending
  parent review. The `jsonl-parity` fixture covers the following original counterexamples
  and UTF-8 slices, separators, and incremental replay. Bun 1.4.4 matches the preserved
  Bun 1.4.2 control byte-for-byte. Before the fix, these cases differed (probed with native `bun` and the
  emitted factory; the conversion keeps them unchanged, and the `runtime-ts-jsonl` fixture
  covers only the cases where both agree):

  | Call | Native Bun 1.4.2 | bun-wasm before fix |
  | --- | --- | --- |
  | `parseChunk('"a\\u00')` | error | incomplete, `error: null` |
  | `parseChunk("1e+")` | `values: [1]`, `read: 1`, error | incomplete |
  | `parseChunk("true [")` | `values: [true]`, error | `values: [true]`, `error: null` |
  | `parseChunk("true 7")` | `values: [true]`, error | `values: [true, 7]` |
  | `parseChunk("[1,]")`, `parseChunk("truX")` | incomplete, `error: null` | error |
  | `parseChunk('true\n{"bad":}')` | `values: [true]`, `error: null` | `values: [true]`, error |
  | `parse("invalid")` | returns `[]` | throws `SyntaxError` |

  Native values must be newline-separated, and some malformed tokens read as incomplete.
  Bun's `jsFunctionJSONLParseChunk` (`src/jsc/bindings/BunObject.cpp`) delegates to
  `JSC::streamingJSONParse` in Bun's WebKit fork (`Source/JavaScriptCore/runtime/JSONObject.cpp`
  at the pinned WebKit commit). The port keeps Rust-backed value materialization and
  the iterative container stack. Regenerate the fixture with `scripts/test.sh --update jsonl-parity`.
- `node:url` parity now covers the three recorded gaps in `runtime-ts-url-decoder`.
  Installed Bun 1.4.2 and 1.4.4 agree on the expanded fixture. `fileURLToPath(7)`
  reports the `url` string argument, `format` uses URLSearchParams query semantics,
  and the `domainToUnicode` native reuses Rust URL/IDNA validation and decoding.
  The fixture also covers invalid input types, scheme errors, form escaping,
  repeated query pairs, record coercion, invalid IDNA, hostname delimiters, IP
  addresses, and throwing domain coercion.

  Approved remaining file-URL boundary follow-up, observed with installed Bun 1.4.4:
  `fileURLToPath("file:///a%ZZ")` returns `/a%ZZ`, while our `decodeURIComponent`
  throws. `fileURLToPath("file:///a%C3")` returns an empty string, while ours throws.
  Reproduce both through `bun -e` and the emitted `node_url` factory, then compare
  the file-path byte decoding in Bun's native binding before changing it. The
  argument/query/IDNA fix deliberately does not redesign file-path decoding.
- Bun's own `node:test` (`vendor/bun/src/js/node/test.ts`, 2,874 lines) depends on
  `internal/test_runner`, `internal/validators` and the JSC test runner's `jest(Bun.main)`
  entry. Replacing our 22-line adapter with it is a separate port, not part of a type
  conversion.

## Pristine process gate failures during small API verification

Status: Done. PR #52, `390bda6d`, fixed broken-pipe handling, and PR #87,
`2f20be1b`, corrected missing-process contracts. The unchanged `node-misc` and
`pipe-closed-output` fixtures pass on QuickJS, JSC and browser in the
2026-10-23 replay. Unhandled output exits 1; handled output retains its exit
code, callback identity, ordering and survival checks. No expectation was
weakened. The original failures below predate these fixes. Evidence is in
`/work/reports/wave-20261022/bun-wasm/real-bun-followups/listen-all-final.log`.
The first light-class JSC attempt exited 137 before output; the suite-class
rerun passes and is the verification result.

The small API lane built pristine main `b7cf06cde1fbf977b748d97d86ba102262d3f03f`
and its branch independently. All seven new API/CLI fixtures pass on QuickJS,
JSC and browser. Each full fixture gate reports 205 passes and the same two
failures. The pristine QuickJS control reproduces both failures unchanged:

- `node-misc` prints false for its ENOENT checks on `child_process.spawn` and
  `Bun.spawnSync`, where the existing manual fixture expects true.
- `pipe-closed-output` reports exit 141 instead of 1 for unhandled stream output
  on QuickJS/native and QuickJS/node. Its node-host batch case also exits 141.

Reproduce from the pristine control checkout with its built launcher and wasm:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-small-causes-base-target
scripts/test.sh --no-build node-misc pipe-closed-output
```

Run through the heavy wrapper. The control checkout is at
`/work/worktrees/bun-wasm/small-causes-base` until lane cleanup; recreate it at
that commit afterward. Exact output is retained in
`/work/reports/bun-wasm-small-causes/base-regressions.log`, with status 1 in
`base-regressions.status`. Task gate logs are `gate-quickjs.log`, `gate-jsc.log`
and `gate-browser.log` in the same report directory. The control records zero
passes and two failures; the closed-pipe batch callback case passes.

Inspect `crates/bunwasm-runtime/src/js/bootstrap.js` near `handleBrokenPipe`,
which raises guest SIGPIPE for EPIPE, and the process/native error translation
used by `src/js/spawn.js`. Do not change expected exit codes or unsupported
process checks merely to make the gate green. Confirm the intended Bun stream
and absent-host contracts first. The API lane changes reproduce neither cause
uniquely, so they do not explain these failures.

The full web gate and all six Chromium/WebKit HMR runs pass on the API lane.
The coordinator owns retaining the report evidence until the process follow-up
has reproduced and resolved these blockers.

## Browser occupied-port follow-up after fake timers

Status: Done, verified on 2026-10-23.

The focused `net-http-listen-error` regression first failed on pristine browser
main `5fa3a24f` because the occupied listener announced `listening`. It now passes
with real and fake timers, and immediate close cancels startup. The fix waits on
`hostLocalAddr` through an I/O waiter before publishing either success or the
host bind error. No timer, delay, retry, or Node socket-probe change is involved.
Twelve deterministic startup and actual HTTP factory checks pass. The review
regression first delivered a queued `connection` before `listening`; acceptance
now starts only after the listen callback returns and only if it left the server
open. Pending binds cannot accept, and `unref` in that callback applies to the
accept waiter. Close-and-relisten callbacks keep one waiter per startup and leave
zero referenced waiters after final close. Plain relisten delivers each queued
connection once; a guest fixture also requires the reused server process to exit.
After rebasing onto main `23e2125d`, the strict runtime check and 131 unit tests,
lint, project type checks and duplicate gate pass. A browser guest rebuilt from
`24439c73` passes the listener process-exit, framing and stream fixtures, three
passed and zero failed. The test server and scratch cleanup were checked locally.
The earlier six-fixture listener/process/framing runs and unchanged upstream
pipeline runs passed on all three engines, but predate both review fixes.
The earlier UpCloud-4 browser replay also passed, with remote teardown verified.
The unchanged upstream timer file reports eight passes and three pre-existing
lazy matcher failures, recorded separately below. All listener tests pass.
Evidence is in `/work/reports/wave-20261022/bun-wasm/real-bun-followups/` and
`/work/reports/machine-fleet/remote-gate/real-bun-listener-final-20261023T064132Z-1r84crw0/`.

The PR307 review later exposed a pre-existing TCP-only stale-startup race: a
sibling server's listen callback could close and synchronously rebind a second
server before its canceled waiter ran from the same pump snapshot. The TCP
waiter now uses the HTTP helper's token identity and announcing-phase guards.
Focused tests cover sibling replacement, callback close/relisten and nested
pumps for both protocols. This source-only follow-up adds no timer, retry,
host capability or guest acceptance claim.

The 12-file fake-timer after measurement passes 42 tests on QuickJS and JSC.
Browser passes 41, with one 2-second timeout in
`js/bun/test/test-timers.test.ts`, test
`http.Server#listen() while fake timers are active > emits 'error' for a port that is in use without fake time being advanced`.
The other ten tests in that file pass. This is one observed failure in one
bounded measurement, without a retry or a longer timeout.

Inspect `web/scripts/node-net.mjs:hostListen`: it obtains a port with a temporary
synchronous listener, closes that probe, then binds the actual named-host listener
asynchronously. `crates/bunwasm-runtime/src/js/net.js:Server.listen` publishes
`listening` immediately through `internal.nextTick`; its accept loop does not
forward a later listener error. Verify this suspected bind/error-delivery race
with fake timers both disabled and enabled before changing the networking adapter.
No networking implementation or test expectation was changed by the timer lane.

Reproduce with built artifacts and the standard dependencies, through the suite-class runner:

```sh
source env.sh
scripts/bun-suite.sh --engine browser --jobs 1 --timeout 15 --network loopback \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-listen-review/browser.json \
  js/bun/test/test-timers.test.ts
```

Raw output is retained in
`/work/reports/bun-wasm-fake-timers/after-browser-logs/js/bun/test/test-timers.test.ts.log`.
The coordinator owns this evidence until the networking follow-up is verified.


### Lazy test matcher initialization after replacing timer globals

Status: Approved, separate from the occupied-port fix. On 2026-10-23, the
unchanged `js/bun/test/test-timers.test.ts` replay reports eight passes and
three failures on browser. All HTTP/TCP listener tests pass. Each failure
replaces `globalThis.setTimeout` with a string, symbol or bigint before
`Bun.jest()` initializes the matcher adapter.

A pristine browser guest from main `5fa3a24f`, SHA-256
`2bb4fe06c65d3a09c75f6c6c84f3ccbababea2ce966d432447dc5be05d33865f`,
reproduces the string case with exit 1. Native Bun 1.4.2 prints `ok`:

```sh
node --experimental-wasm-jspi web/scripts/node-host.mjs --wasm \
  /work/tmp/bun-wasm-real-bun-followups-artifacts/bun-browser.wasm -- -e "globalThis.setTimeout = 'x'; const jest = Bun.jest().jest; jest.useFakeTimers(); console.log('ok');"
```

The guest throws `TypeError: setTimeout.bind is not a function`.
Inspect `crates/bunwasm-runtime/src/js/test_matchers.ts:11`, which captures
`schedule` from the mutable global during lazy initialization rather than
using the bootstrap's saved timer. This is not caused by listener binding
or the new startup waiter. Evidence and the native control are in
`/work/reports/wave-20261022/bun-wasm/real-bun-followups/timers-pristine-control.log`;
full upstream results are in `timers-browser.json` and `timers-browser-logs/`
in the same directory. The real-Bun follow-up lane retains this baseline
artifact until the timer follow-up is reproduced, then removes it.

## Browser host call allocation abort on an 8 MiB hash input (iOS E3)

Status: Approved (owner, 2026-11-05) for recording this finding and for the
source-only diagnosis below. Not approved: a new guest build, a device run, a
threshold scan or a runtime change. Those need a separate owner decision.

### What was observed

The product is the original admitted runtime 110 browser guest, source
`e1dea936b0fe9de664ecc3980550cc091d1be120` (tree `bb90b2ff`). Its sealed
delivery in `/work/artifacts/bun-wasm-runtime110-20261105/delivery` stays
unchanged. The separately admitted private browser fallback guest (`425bef5a`)
is a different artifact and is not involved.

On an iPhone in Safari, the Waffle Nuxt E3 run `e3-r110-chunked-1` staged 24
chunks with an 8 MiB chunk limit. The first chunk contained 8,388,608 bytes.
The restorer (SHA-256 `60190aeb…`) then exited 1 on that first chunk, before
Nuxt ran:

```
memory allocation of 8388608 bytes failed
RuntimeError: Unreachable code should not be executed (evaluating 'e.bunwasm_call(v,F,R.len)')
```

The captured import-rejection stack, innermost first:

```
wasm-function[91]
wasm-function[80]
bunwasm_runtime::engine_host::Reader::val   (wasm-function[7679])
bunwasm_runtime::engine_host::Reader::val   (wasm-function[7679])
bunwasm_call                                (wasm-function[7835])
p  (__bunwasm/worker.js:8:71598)
digest
readChunk (restore-tree.ts:287)
```

Restorer line 287 is `sha256(bytes)`, defined as
`new Bun.CryptoHasher("sha256").update(bytes).digest("hex")`. The stack names
`digest`, not `update`, as the frame that crossed into the guest. That fits the
source: `update` only buffers in JavaScript.

In the same guest process, earlier steps had succeeded: a `readFileSync` of the
3,097,113-byte `tree.json`, a hash of 2,075,558 bytes of inventory text through
the same hasher, and the `readSync` loop that filled this same 8 MiB chunk.
Those are different operations in different memory states. They establish no
size threshold, no size interval, and no cause in total memory, fragmentation,
a wasm memory growth limit or Safari's allocator. One earlier large-file read on
PC Chromium did not reproduce this; no threshold campaign was run. The Nuxt
command never ran, and no `TypeError` cause is attributed. No Waffle defect is
shown.

### Source call chain at e1 (static reading only)

`engine_host.rs`, `engine-host.js`, `bun.js`, `web.js` and `natives.rs` have no
diff between `e1dea936` and main `cac10b72` for the code below, so the line
numbers hold on both.

1. `crates/bunwasm-runtime/src/js/bun.js:291` `CryptoHasher.update` copies the
   input with `internal.toUint8(data).slice()` and keeps it in `#chunks`
   (JavaScript heap, input-sized).
2. `bun.js:296` `digest` calls `internal.concatBytes(this.#chunks)`
   (`web.js:656`), which always allocates a new array of the total size, even for
   one chunk (JavaScript heap, input-sized).
3. `native.hash(alg, input)` goes to `web/src/engine-host.js:296` `call`. The
   `Writer` (`engine-host.js:129`) serializes `[alg, input]`, doubling its
   capacity from 256 bytes. For this input its JavaScript backing buffer
   reaches 16,777,216 bytes. Capacity is not a measurement of live heap or
   peak memory.
4. `engine-host.js:299` `exports.bunwasm_alloc(w.len)` allocates a zeroed guest
   buffer of `w.len` = 8,388,608 + 21 framing bytes (array header, the
   `"sha256"` string, the byte-length header) at `engine_host.rs:222`. The
   JavaScript side copies the encoding into it. This allocation succeeded,
   because `bunwasm_call` was entered.
5. `engine_host.rs:262` `bunwasm_call` takes ownership of that buffer as
   `input` and calls `decode(&input)`. The outer `Reader::val` (`:120`) reads
   the array tag and recurses for each item. The inner `Reader::val` reads the
   bytes tag and runs `Val::Bytes(self.take(n).to_vec())` at `:132`, a second
   guest allocation of exactly n = 8,388,608 bytes. `input` is dropped only
   after `decode` returns (`:269`).
6. Not reached: `natives.rs:1321` `hash` and `set_result` (`engine_host.rs:193`).

The failure most likely maps to step 5: the reported size is exactly n (step 4
asks for n + 21), and the stack shows two nested `Reader::val` frames under
`bunwasm_call`, which matches decoding an array whose second item is bytes. At
that point the guest heap holds both the 8 MiB + 21 byte input and the new
8 MiB copy request. This is a source match, not proof of the exact
allocating source line: the copy is inlined into `Reader::val`. The admitted
guest's name section identifies frame 80 as `alloc::raw_vec::handle_error`
and frame 91 as `alloc::alloc::handle_alloc_error`. Those names confirm an
allocation-error path, not why the allocation failed.

One nearby ownership fact, not tied to this failure: `RESULT`
(`engine_host.rs:159`) is a thread-local `Vec` that `set_result` clears but
never shrinks. However, the regular-file `readSync` path in
`node_fs.js:451-476,502-506` splits large reads through `readRegularPieces`,
requesting at most 1 MiB from each native `read_descriptor` call. The public
8 MiB read therefore establishes neither an 8 MiB native read nor 8 MiB of
retained `RESULT` capacity. Actual native read sizes and retained capacity
were not instrumented.

### Completed read-only verification

The independent source review selected the Browser guest through the sealed
`split/web/engine-builds.json` registry and verified SHA-256
`ddadea2faae59b516f51e743009b49d41db8a57bd3add1dcec33d105e2739b7c`
at `browser/default/bun-browser.wasm`. `wasm-tools print --skeleton` read its
name and memory sections without guest instantiation or execution. Function
7679 is `Reader::val`, and 7835 is `bunwasm_call`; functions 80 and 91 are
identified above.

Memory 0 declares 247 initial pages and 16,384 maximum pages. With 65,536
bytes per page these are 16,187,392 and 1,073,741,824 bytes. Neither
declaration reveals memory size at failure, free allocator capacity,
successful or refused growth, or the allocation-failure cause. No guest
build, device run or threshold experiment occurred.

### Unknowns

- Whether the inlined allocation is exactly the `:132` `to_vec`. Function
  names and the request size support that mapping, but no source-line symbols
  or allocator-site measurement prove it.
- Why the allocation failed: live guest heap state, a refused memory growth,
  fragmentation, total browser memory pressure, or another cause. The
  declarations above do not distinguish these possibilities.
- The guest's live allocation bytes and peak at failure. Nothing recorded them.
- Whether the earlier `EIO` in `e3-r110-import-1` is the same allocation.
  Sharing a host frame region does not establish that.

### Future regression direction. No build authorized

A later fix needs a known SHA-256 correctness vector for an 8 MiB input.
If that fix removes the decode copy, add separate allocation accounting:
construct the encoded `["sha256", bytes]` input before accounting starts,
then count allocation requests of at least the payload size only while
`decode` runs. The present bytes branch requests one payload-sized copy.
The borrowed-decode direction would assert zero such additional requests,
while checking decoded content and argument lifetime. Exclude input
construction, native hashing and result encoding from this counter.

This metric counts allocation requests and their sizes. It does not measure
live allocator bytes, JavaScript heap, or committed WebAssembly linear
memory. Do not substitute `memory.buffer.byteLength` or an uncalibrated
"near one input" growth budget. Incremental native hashing or shrinking
`RESULT` are separate candidate changes that need their own stated metric;
no fix is selected by this record.

Any runtime change needs its own reviewed source, guest build and applicable
engine verification before a new admission. This task authorizes none of
those executions. The sealed runtime 110 delivery stays unchanged.

Waffle's lead is bounding each restorer hash, read and write to small windows on
the original product to reach Nuxt. Multiple small `update` calls on one
current hasher still produce one combined native call at `digest`, so they
do not bound that call. The workaround must bound the total bytes per digest
or use genuinely incremental hashing while preserving its verification
semantics. That is not a runtime fix or proof of cause.

Evidence: `/work/reports/wave-20261105/waffle/nuxt-iphone-reopen/lead-debugger/e3-r110-chunked-1/`
(`RESULT.md`, `records.jsonl` line 5, journal array index 52 with worker
sequence 16). The projection
and source references are in `/work/reports/wave-20261105/engines/host-api-allocation-e3/`.


## Bounded desktop startup and graph costs after registration loading

Status: Completed November 6, 2026. Owner: Engines. The Approved follow-up belongs to PR 482 and the worker-module-loader track. Existing e1/d313 artifacts were measured in desktop Chromium and Playwright WebKit. No clear common trivial-startup regression was observed. Positively controlled WebKit command completion was 101.72 to 107.68 ms; its 200-module graph interval was 137.96 to 188.10 ms. Chromium worker control remained unproven. All eight new graph invocations returned checksum 19900. No capability-gating product change is justified by this bounded pass alone. Browser read costs remain unmeasured.

Results, every sample and the reproducer are in `/work/reports/wave-20261105/waffle/nuxt-iphone-reopen/worker-module-loader-fix/implementation/startup-followup/`. Owned browser/server processes and the copied snapshot were removed. This was an experimental Linux headless comparison, not current-head or iOS performance acceptance.

The protocol below is the historical executed measurement plan. Its old private-build/E3 fences do not apply to future development: the November 6 owner development-loop rule permits ordinary builds, tests and retries without custody or intake campaigns. Preserve original admitted artifacts and history, and keep real automated tests, independent review and green CI at merge.

Status: Approved. Owner: Engines. This follow-up belongs to PR 482 and the worker-module-loader track. Managing accepted the documented Node read overhead for this correctness fix on November 6, 2026. The acceptance does not cover semantic regressions or establish browser performance.

Measure Chromium and Playwright WebKit on the PC with existing built old/new artifacts. Do not build a new guest or host bundle for this measurement, reserve the Mac, reinstall E2, or consume the private e1 diagnostic build or E3 allowance. If a complete source-bound old/new artifact pair is unavailable, record that prerequisite instead of manufacturing provenance or rebuilding it here.

Before execution, bind each artifact tree, source/build receipt, guest, compressed variant, metadata and browser version. Record all known source differences rather than attributing unrelated changes to the loader. Preserve the artifacts and use owned short scratch paths and local fixture ports. Install teardown before starting services or browsers and verify it on the PC after the run.

Use one fixed pass for each browser, artifact and control condition. Each pass has two sequential guest processes with the same bootstrap and the same 200-module graph. Report every sample, including failure. No reruns for nicer timings and no open-ended tuning. Bound the overall measurement at 15 minutes.

Record asset headers, decoded/compressed identities, response provenance, service-worker registrations, Cache Storage and HTTP cache conditions. A fresh context is context-cold, not proof of a cold OS or compiler cache. Record the second process as a pool-spare/warm case only when the actual worker evidence supports that description.

Measure navigation to published page readiness, command dispatch to executing-guest startup, startup to graph completion, and disposal separately. Emit checksums and worker capability evidence from an acyclic bootstrap before dynamically loading the graph. Retain actual executing-worker control observations and request attribution. An unavailable worker API is not a null controller, and a controlled page or scoped URL is not evidence that its worker is controlled. Keep failed old uncontrolled-cycle imports as failures, not timing successes. Positively prove the controlled-worker case or report that case unproven.

Compare the app-relevant startup and graph phases under like asset/cache conditions. Do not extrapolate the Node 5.2x/45x read ratios, the 27.5-to-68.7 ms graph result, or the roughly 15 ms hello-world difference to either browser.

If normal startup in a genuinely service-worker-controlled worker regresses noticeably, take only the obvious bounded correction: choose one module mode per process from actual worker capability before entry. Use the old fast path only when the required capability exists. Use records when the controller is null or capability is missing/unavailable. Never infer native capability from a worker URL or scope. Do not restore a mixed native/record namespace bridge, pre-await dependency path, version-skew branch or mid-process mode switch.

Any resulting product change requires normal source review and required checks on the changed head before merge or the private diagnostic build. Report remaining costs or an unresolved capability/control observation before widening this follow-up. Keep the one private e1-plus-reviewed-delta build and Nuxt's one later E3 separate.
