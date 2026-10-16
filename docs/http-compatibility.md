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

The web gate currently stops at the separately tracked browser memory-growth
failure after the shared filesystem merge. The HTTP lane reproduced that timeout
in the full gate, an isolated rerun, and a control using unchanged main guest
artifacts. All other requested gates pass. The owning follow-up is recorded in
`plans/compatibility-followups.md`; no HTTP workaround is applied.

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
