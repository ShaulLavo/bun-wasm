# HTTP response and upgrade compatibility

The HTTP adapter now commits headers when `writeHead()` runs, preserves explicit
transfer encoding, and sends body chunks before `end()`. The client reads ordinary
HTTP responses over sockets so raw header names, duplicate fields, trailers and
EOF remain available. HTTPS upgrades without a caller-supplied TLS connection
fail with `ERR_TLS_NOT_SUPPORTED` because the socket ABI has no TLS transport.

The controls use Node v26.7.0. The original fixtures run under QuickJS, JSC and the
browser engine. No upstream test or framework source is changed.

| Path | Regression coverage |
| --- | --- |
| Header commitment | `headersSent`, late `setHeader` rejection, repeated flushes |
| Header representation | Casing/order, reserved names, arrays/append, raw `writeHead` arrays |
| Response framing | Explicit chunked encoding, streaming before EOF, HEAD, 204/304, explicit lengths |
| Trailers and connections | Request/response raw trailers, same-socket pipelining, connection close |
| Status and events | Custom status messages, 100 Continue before the request body, finish/close order |
| Upgrade client | TLS rejection, method/path/header validation, ordered body writes, non-101 body/EOF, unhandled 101 cleanup |
| Upgrade server | Parsed request body, `complete`, request EOF and buffered socket head |
| Value coercion | Top-level undefined rejection, array serialization, Symbol errors |
| Validation order | Path before method before headers, including error messages |
| Malformed response framing | Split negative/nondecimal/duplicate lengths and TE+CL, parser errors before response |
| Agent reuse | Fixed/chunked/HEAD/204/304 reuse, HTTP/1.0, close/EOF, idle guards, timeout, destruction |
| Request framing defaults | GET/HEAD/DELETE/OPTIONS/TRACE/CONNECT raw bodies; POST/PUT/PATCH/PROPFIND length/chunk defaults |

`tests/fixtures/net-http-parity` covers the response paths.
`tests/fixtures/net-http-upgrade-regressions` checks seven client cases for the five reported
bugs and the incoming upgrade body. Its TLS assertion is specific to the
bun-wasm host; native Node supplies the other protocol controls.

PR #35 adds five review regressions under `tests/fixtures/net-http-`, with suffixes
`value-coercion`, `validation-order`, `response-framing`, `agent-reuse`, and
`get-framing`. These run unchanged on Node v26.7.0 and each guest engine.
Malformed response cases arrive in separate socket writes. They assert one parser
error, no `response` event, and bounded completion. Transfer codings such as
`xchunked` and `chunked, gzip` use EOF framing; only a final `chunked` is decoded.

The socket pool releases a connection after the response stream ends. Idle sockets
are unreferenced, keep no request parser listeners, and close on unsolicited data,
errors, EOF or timeout. Agent destruction closes both active and idle sockets.
`agent: false` and Agents without keep-alive advertise `Connection: close`.
The adapter does not yet schedule requests against `maxSockets` or
`maxTotalSockets`. Fixed response lengths must fit a safe JavaScript integer;
native Node's uint64 parser also accepts larger lengths that this decoder rejects.
Symbol coercion throws a native `TypeError`; its wording depends on the engine.

Round 2 adds `net-http-response-remainder` and
`net-http-empty-transfer-encoding`. The remainder control covers fixed, chunked,
HEAD, 204 and 304 responses, same-write and split-write suffixes, paused response
consumption, idle data, and an unsolicited complete response. It preserves the
first body/end, checks parser errors for invalid suffixes and verifies that the
next request uses a fresh socket. Explicit close and HTTP/1.0 controls check
`HPE_CLOSED_CONNECTION`. Empty transfer-encoding controls split the header across
writes and check GET/HEAD, 100/101/200/204/304 and repeated fields. They require one
`HPE_INVALID_TRANSFER_ENCODING` with no response, information or upgrade dispatch.
All controls run unchanged on Node v26.7.0.

The decoder exposes its unconsumed remainder explicitly. Any remainder retires
the connection synchronously, including a recognized next-response prefix. An
incomplete recognized prefix is also retired rather than held for another
request. The Agent guards the draining interval before stream consumption as
well as the idle interval after release.

The subsequent Streams merge required the HTTP client to use Writable lifecycle
hooks. The transport retains end-body framing and abort cleanup inside those
hooks. `net-http-close-order` additionally compares an HTTP request stream and
its destroyed TCP socket against Node. Completing TCP destruction in a later
check phase preserves request-close before socket-close and prevents the
Streams integration from changing that order.

## HTTP scoreboard census, 2026-10-18

The starting scoreboard at `2ea5c62fa6bb63cc5396cb345e3897956bb710f1` assigns
180 files to category d, HTTP/server/fetch/WebSocket semantics. Within those
180, 32 have no named failure. The recorded count of 25 does not match this
checkout. These are first-error groups, not 180 confirmed HTTP protocol bugs.
An assertion method such as `toBe` does not identify one shared cause.

There is no live HTTP PR at the start of this work. The previous HTTP, TCP and
portable ws lanes merged as PRs #35, #14 and #16. The 11 Socket.IO collection
failures all report the same missing `ws` builtin in their raw excerpts.
PR #42 already fixed that CommonJS lookup. The fresh QuickJS control passes
three of those files; the other eight are skip-only. TLS, QUIC, Unix sockets,
private engine instrumentation and subprocess-dependent fixtures remain
separate from the portable HTTP adapters.

Generate this table and its complete file membership with
`node scripts/http-suite-report.ts <scoreboard.tsv> <suite.json>`. The optional
second argument reads the raw JSON to recover errors hidden by the recorded excerpt placeholder.
The raw historical JSON is
`/work/reports/bun-wasm-main-2026-10-17/suite/quickjs.json`.

<!-- http-first-errors:start -->
| First error | Files | Example |
| --- | --- | --- |
| error: expect(received).toBe(expected) | 37 | js/bun/http/async-iterator-stream.test.ts |
| ^ this test timed out after 2000ms. | 16 | js/bun/http/node-http-pipeline-callbacks.test.ts |
| ENOENT: no such file or directory | 13 | js/third_party/socket.io/socket.io-close.test.ts |
| error: expect(received).toContain(expected) | 13 | cli/test/isolation.test.ts |
| error: Bun.serve TLS is not supported by this networking host | 11 | cli/install/migration/pnpm-comprehensive.test.ts |
| error: expect(received).toEqual(expected) | 11 | js/bun/dns/dns-prefetch.test.ts |
| File timeout without a captured error | 7 | js/bun/http/bun-serve-html-build-holds-server.test.ts |
| TypeError: not a function | 5 | js/bun/http/listener-getsockname.test.ts |
| error: expect(received).toThrow(expected) | 4 | js/web/fetch/fetch.unix.test.ts |
| error: expect(received).toMatch(expected) | 3 | js/bun/http/form-data-set-append.test.js |
| SyntaxError: WebSocket requires a ws:// URL without credentials or a fragment | 3 | js/web/websocket/websocket-unix.test.ts |
| TypeError: cannot read property 'Server' of undefined | 3 | js/third_party/grpc-js/test-call-propagation.test.ts |
| AssertionError: Expected values to be strictly equal: | 2 | js/node/http/node-http-agent-free-socket.test.ts |
| error: expect(received).not.toContain(expected) | 2 | cli/install/bun-update-transitive.test.ts |
| error: expect(received).toMatchInlineSnapshot(expected) | 2 | js/web/fetch/response.test.ts |
| error: Expected process to exit with code 0 but got 1 | 2 | js/bun/http/leaks-test.test.ts |
| error: No such built-in module: node:quic | 2 | js/bun/http/serve-http3.test.ts |
| error: Unix sockets and TLS sockets are not supported in bun-wasm | 2 | js/bun/http/bun-listen-connect-args.test.ts |
| error: Unix sockets are not supported in bun-wasm | 2 | js/node/net/handle-leak.test.ts |
| error: zlib.brotliCompressSync is not supported in bun-wasm: brotli is not compiled into bun.wasm | 2 | js/web/fetch/fetch-gzip.test.ts |
| TypeError: parent class must be constructor | 2 | js/first_party/undici/undici-primordials.test.ts |
| AssertionError: path.win32.resolve("c:/blah\\blah","d:/games","c:../a") | 1 | js/node/path/resolve.test.js |
| BuildError: Expected ";" but found "RSA" | 1 | js/bun/http/bun-serve-ssl.test.ts |
| BuildError: Unexpected � | 1 | js/web/fetch/fetch.brotli.test.ts |
| bun-wasm: bun.wasm trapped: error while executing at wasm backtrace: | 1 | js/node/http/node-http-uaf.test.ts |
| EACCES: permission denied | 1 | bake/dev/ecosystem.test.ts |
| error: bun create is not supported in bun-wasm | 1 | cli/create/create-jsx.test.ts |
| error: expect(received).not.toStartWith(expected) | 1 | js/bun/http/proxy-stress-lifecycle.test.ts |
| error: expect(received).toBeDefined() | 1 | regression/issue/24575.test.ts |
| error: expect(received).toBeGreaterThan(expected) | 1 | regression/issue/40111.test.ts |
| error: expect(received).toBeGreaterThanOrEqual(expected) | 1 | js/bun/http/proxy-stress-concurrent.test.ts |
| error: expect(received).toBeObject() | 1 | js/node/perf_hooks/perf_hooks.test.ts |
| error: expect(received).toBeTruthy() | 1 | js/deno/fetch/response.test.ts |
| error: expect(received).toHaveLength(expected) | 1 | js/web/fetch/utf8-bom.test.ts |
| error: expect(received).toInclude(expected) | 1 | js/web/fetch/headers-case.test.ts |
| error: expect(received).toMatchObject(expected) | 1 | js/node/http/node-http-upgrade-body.test.ts |
| error: expect(received).toStrictEqual(expected) | 1 | js/node/net/node-net-server.test.ts |
| error: expect(received).toThrow() | 1 | js/bun/http/server-url-invalid.test.ts |
| error: expect(received).toThrowErrorMatchingInlineSnapshot(expected) | 1 | js/web/fetch/blob-write.test.ts |
| error: No such module: http_parser | 1 | js/node/http/node-http-parser.test.ts |
| error: WebSocket proxy and TLS options are not supported by this networking host | 1 | js/web/websocket/websocket-buffered-amount.test.ts |
| error: WebSocket was closed before the connection was established | 1 | regression/issue/012040.test.ts |
| QuotaExceededError: The ArrayBufferView's byte length (1000000) exceeds the number of bytes of entropy available via this API (65536) | 1 | js/web/fetch/body.test.ts |
| SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc' | 1 | js/bun/websocket/websocket-server.test.ts |
| SyntaxError: The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:" | 1 | cli/inspect/inspect-inline-sourcemap.test.ts |
| SyntaxError: Unexpected end of JSON input | 1 | js/bun/http/serve-stream-body-error.test.ts |
| TypeError: Body already used | 1 | js/bun/http/serve-reused-response.test.ts |
| TypeError: cannot read property 'counter' of undefined | 1 | regression/issue/18595.test.ts |
| TypeError: cannot read property 'hash' of undefined | 1 | packages/s3-server/test/server.test.ts |
| TypeError: class constructors must be invoked with 'new' | 1 | js/node/net/server.spec.ts |
| TypeError: formData() is not supported in bun-wasm | 1 | js/bun/http/fetch-file-upload.test.ts |
| TypeError: Invalid URL: "1" | 1 | js/bun/http/bun-serve-fetch-invalid-args.test.ts |
| TypeError: Invalid URL: "http://undefined:undefined/api/hotels" | 1 | js/third_party/express/express.test.ts |
| TypeError: protocol must be http:, https: or s3: | 1 | js/web/fetch/fetch-args.test.ts |
| TypeError: Request with a GET or HEAD method cannot have a body. | 1 | js/web/fetch/fetch.upgrade.test.ts |
| TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch() | 1 | js/web/fetch/chunked-trailing.test.js |
| TypeError: UnexpectedRedirect fetching "http://127.0.0.1:43277/". For more information, pass `verbose: true` in the second argument to fetch() | 1 | js/web/fetch/fetch-redirect.test.ts |
<!-- http-first-errors:end -->

The generic assertions split across independent behavior. Static-route aliases,
ETags and directory routes differ from header conversion, fetch decompression,
body conversion, socket ownership and WebSocket framing. Their shared assertion
text is not a reason to replace those implementations together.

The server's whole-body buffering is a shared cause that the current code and
runtime controls confirm. `serveHttp` waits for a complete upload before it
calls a Node request listener. A client waiting for a response before ending
its upload cannot make progress. `writeResponse` also waits for `arrayBuffer()`
before sending Bun Response headers. A stream that waits for a client handshake
cannot make progress either. The new fixtures reproduce both cycles without
subprocesses or external network access.

The typed server driver now dispatches Node request headers first, forwards
incremental body chunks and trailers, and updates `req.complete` at the body
terminator. IncomingMessage backpressure pauses host reads. Request reading
resumes from `_read`. Connection reuse waits for both upload completion and the
response. Upgrade requests retain the complete-body and buffered-head contract.

Bun Response streams now send headers and chunks before EOF. Socket write
completion controls further reads. Unknown-length streams use chunked framing;
explicit Content-Length streams retain that header. Byte-backed Responses keep
the existing fixed-length path. HEAD and bodyless responses send no stream body.

The embedded streams library also uses Bun's reader-lock error text. The
unchanged upstream file starts a body read before asserting the lock error. A
wording mismatch leaves that read pending when test cleanup closes its server;
the later rejection was attributed to the following deflate test. Tracing shows
the rejection belongs to the prior handle, while direct wrapped and raw deflate
controls pass. The generator now preserves Bun's message without changing
locking or scheduling.

The exact 180-file before and after replays use the unchanged upstream tests,
15-second file deadlines and 2,000 ms test deadlines on all three engines.
These bounded observations include newly reached failures. They do not establish
native memory ownership or leak freedom. TLS transport, CONNECT dispatch,
request timeout policy, queued pipelined response objects and Bun's direct stream
extension remain separate compatibility work.

## Measurements

| Engine | Fully passing upstream files, before → after | Observed passes, before → after | File timeouts, before → after |
| --- | --- | --- | --- |
| QuickJS | 0/13 → 0/13 | 1 → 3 | 0 → 0 |
| JSC | 0/13 → 0/13 | 1 → 3 | 0 → 0 |
| Browser | 0/13 → 0/13 | 1 → 3 | 0 → 0 |

The upstream selection contains thirteen unmodified Bun files. Ten Node assertion
scripts first load the shared Node harness. The other three are
`node-http-transfer-encoding.test.ts`, `node-http-upgrade-body.test.ts`, and
`numeric-header.test.ts` under `test/js/node/http/`.

The retained results identify missing parser and harness APIs, request lifecycle/TLS
comparisons and a Bun-specific `rawHeaders` reassignment expectation. Native Node
keeps its parsed `headers` when that array is replaced, so this change preserves
Node's behavior. File timeout counts exclude individual tests that reported their
own shorter timeout and then let the file finish.

All three HTTP fixtures pass alongside the full 154-fixture suite on every
engine, based on main `9c1e1709`. The offline app matrix passes all 24
install/start stages for Express 5.1.0, Koa 3.0.1, Hono 4.10.2 and Fastify 5.6.1.
HMR passes all six Chromium/WebKit and engine combinations.

The PR #35 review revision measures eighteen upstream files per engine, adding
the method, path, Agent, flushHeaders and content-length references. Before and
after results are identical on QuickJS, JSC and browser: 0/18 fully passing,
3 observed tests passing, 11 failing, 2 skipped, one error, and no file timeouts.
The Node assertion scripts stop in the shared harness at unsupported
`worker_threads`. The five new original fixtures exercise the review findings
directly without changing that harness. The rebuilt framework matrix again
passes all 24 install/start stages.
The revision's sandbox HMR gate passes all six Chromium/WebKit and engine runs.
All three rebuilt engines pass the full 159-fixture suite. The review regressions
report `0 passed, 5 failed` per engine on the original artifacts, then
`5 passed, 0 failed` per rebuilt engine. All five also pass unchanged on Node.
The retained WASMs contain the current HTTP JavaScript and erased TypeScript
factories; `source-check.log` and `artifacts.json` record the checks and hashes.

Round 2 initially passed 161 fixtures before the concurrent Streams merge.
The Streams/persistence integration passes 178 fixtures on every engine. After
the subsequent main-thread worker merge, the final branch passes all 183 fixtures
on QuickJS, JSC and browser, including close-order and new main fixtures. Both framing fixtures
fail on each original artifact and pass on each rebuilt engine. The expanded
twenty-file upstream selection adds `test-http-extra-response.js` and
`test-http-response-multi-content-length.js`. Before/after counts remain identical
on all engines: 0/20 fully passing files, 3 observed tests passing, 11 failing,
2 skipped, one error and zero file timeouts. The Node shared harness remains the
first blocker for its assertion scripts before the worker-module merge.
The Streams integration briefly lost two observed upgrade-body passes; the
failing-first TCP close-order correction restores both on all engines. Final
upstream summaries match the original round-2 baseline.
Main-thread worker support then removes that shared-harness blocker. The final
twenty-file selection passes 16/20 files on each engine with zero file timeouts.
Observed Bun test counts remain 3 passing, 11 failing, 2 skipped and one error;
the newly passing files are unmodified Node assertion scripts. The remaining
files are blocked by `node:_http_common`, the `_http_agent` alias, existing
upgrade-body/TLS differences and Bun's `rawHeaders` reassignment expectation.
The complete round-2 web gate passes, including memory growth on Chromium and
WebKit with all three engines. The framework matrix again passes 24/24 stages.

The earlier web gate stopped at the separately tracked browser memory-growth
failure after the shared filesystem merge. The HTTP lane reproduced that timeout
in the full gate, an isolated rerun, and a control using unchanged main guest
artifacts. PR #36 fixes that failure and is merged into the round-2 branch.
The full web gate passes without an exemption in this round. The historical
follow-up is recorded in `plans/compatibility-followups.md`; no HTTP workaround
was applied.

The first PR #35 web run also timed out waiting for an HTML HMR edit. A fresh
web build and full rerun passed all configured `browser-net.mjs` cases with the
same guest artifacts. No HTTP source change occurred between attempts. The
intermittent observation is retained in this HTTP report and its raw evidence.
The shared memory-growth follow-up remains in the owning plan, marked resolved;
the duplicated HTTP copy was removed to keep concurrent plan additions independent.

## Reproduce

Build each artifact and launcher from this checkout, using private Cargo target
directories. Run heavy commands through the host slot wrapper as described in
AGENTS.md.

```sh
source env.sh
scripts/test.sh
scripts/test.sh --engine jsc
scripts/test.sh --engine browser
scripts/test-web.sh
```

`tests/fixtures/net-http-header-state` additionally checks reserved names, missing
lookups, the eager Host header and numeric key ordering.

The focused fixtures also support `--no-build` and `--engine`.
The exact upstream file selection is recorded in each result's `selection` field.
Repeat it with `scripts/bun-suite.sh --network loopback --jobs 2 --timeout 10` and
an engine-specific output path. [The upstream suite guide](bun-test-suite/README.md#reproduce)
describes dependencies and source snapshots.

```sh
scripts/app-matrix.sh --apps=express,koa,hono,fastify \
  --engines=quickjs,jsc,browser --hosts=native --output=/work/reports/http-matrix
```

Build `site/`, serve its `dist/` with an explicit free port through `web/serve.ts`,
and run `node sandbox/tests/hmr-check.mjs <local-url>` for the HMR gate.

Raw before/after records, native controls, the frozen source hashes, commands and
cleanup checks are retained in `/work/reports/bun-wasm-http-20261016/` for the
coordinator. The coordinator owns removal after accepting the PR's independent
review and rebuilt artifacts.
PR #35 revision evidence and rebuilt artifact copies are retained separately in
`/work/reports/bun-wasm-http-pr35/` under the same cleanup ownership.
Round-2 records and rebuilt copies are in `/work/reports/bun-wasm-http-pr35-r2/`.
