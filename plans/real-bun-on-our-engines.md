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

### Current combined replay

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
