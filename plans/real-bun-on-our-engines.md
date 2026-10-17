# Real Bun on our engines

Status: Approved (owner, 2026-10-15)

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
follow-up has reproduced it. See `docs/app-matrix/README.md` for the replay command.

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
start is blocked by build. See [the exact command and retained evidence](../docs/app-matrix/README.md#browser-import-parsing-follow-up).
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
The [app-matrix record](../docs/app-matrix/README.md#web-streams-round-3-replay-with-semantic-imports)
links the exact artifacts and all 12 stage outcomes. PR #24's later WASI-host
merge has separate verification before this lane's delivery.
## TypeScript follow-up

Status: Approved. Execute after remaining runtime PRs #12, #14, #16, #18, #19 and #20 merge.

Convert the remaining runtime JavaScript to TypeScript in small module groups. Prefer replacing
our implementations with Bun's own builtin modules where available. Extend `src/js/runtime.d.ts`
with each native or engine contract used, keep strict checking enabled, and compare all three
engines before and after each group. Regenerate copied/generated files from their generators
rather than changing their output by hand. Reconcile this list with the merged tree first.

Remaining files at this change:

- `crates/bunwasm-runtime/src/js/array_buffer_sink.js`
- `crates/bunwasm-runtime/src/js/assert.js`
- `crates/bunwasm-runtime/src/js/bootstrap.js`
- `crates/bunwasm-runtime/src/js/buffer.js`
- `crates/bunwasm-runtime/src/js/builtins.js`
- `crates/bunwasm-runtime/src/js/bun.js`
- `crates/bunwasm-runtime/src/js/bun_builtins.js`
- `crates/bunwasm-runtime/src/js/bun_console_constructor.js`
- `crates/bunwasm-runtime/src/js/bun_sqlite.js`
- `crates/bunwasm-runtime/src/js/bun_test.js`
- `crates/bunwasm-runtime/src/js/console.js`
- `crates/bunwasm-runtime/src/js/console_constructor.js`
- `crates/bunwasm-runtime/src/js/cookie.js`
- `crates/bunwasm-runtime/src/js/events.js`
- `crates/bunwasm-runtime/src/js/formats.js`
- `crates/bunwasm-runtime/src/js/function.js`
- `crates/bunwasm-runtime/src/js/html_server.js`
- `crates/bunwasm-runtime/src/js/inspect.js`
- `crates/bunwasm-runtime/src/js/intl.js`
- `crates/bunwasm-runtime/src/js/jsonl.js`
- `crates/bunwasm-runtime/src/js/net.js`
- `crates/bunwasm-runtime/src/js/node_fs.js`
- `crates/bunwasm-runtime/src/js/node_url.js`
- `crates/bunwasm-runtime/src/js/path.js`
- `crates/bunwasm-runtime/src/js/process.js`
- `crates/bunwasm-runtime/src/js/spawn.js`
- `crates/bunwasm-runtime/src/js/stack_trace.js`
- `crates/bunwasm-runtime/src/js/string_decoder.js`
- `crates/bunwasm-runtime/src/js/structured_clone.js`
- `crates/bunwasm-runtime/src/js/temporal.js`
- `crates/bunwasm-runtime/src/js/util.js`
- `crates/bunwasm-runtime/src/js/web.js`
- `crates/bunwasm-runtime/src/js/websocket.js`
