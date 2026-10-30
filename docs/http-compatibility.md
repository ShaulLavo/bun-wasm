# HTTP response and upgrade compatibility

The HTTP adapter commits headers when `writeHead()` runs, preserves explicit
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

Five more fixtures live under `tests/fixtures/net-http-`, with suffixes
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

`net-http-response-remainder` and
and `net-http-empty-transfer-encoding` cover the response remainder and empty transfer-encoding. The remainder control covers fixed, chunked,
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

The HTTP client uses Writable lifecycle hooks. The transport retains end-body framing and abort cleanup inside those
hooks. `net-http-close-order` additionally compares an HTTP request stream and
its destroyed TCP socket against Node. Completing TCP destruction in a later
check phase preserves request-close before socket-close.

## Reproduce

Build each artifact and launcher from this checkout, using private Cargo target
directories. Heavy commands run through the host slot wrapper described in
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
an engine-specific output path. [The upstream suite guide](bun-test-suite/results.md#reproduce)
describes dependencies and source snapshots.

```sh
scripts/app-matrix.sh --apps=express,koa,hono,fastify \
  --engines=quickjs,jsc,browser --hosts=native --output=reports/http-matrix
```

Build `site/`, serve its `dist/` with an explicit free port through `web/serve.ts`,
and run `node sandbox/tests/hmr-check.ts <local-url>` for the HMR gate.

## Current results

- Against the starting scoreboard, 180 upstream files are assigned to the HTTP, server, fetch and WebSocket category. These are first-error groups, not 180 confirmed protocol bugs. Generate the table and file membership with `node scripts/http-suite-report.ts <scoreboard.tsv> <suite.json>`.
- Final response-streaming and empty-EOF adapters, same 180 files on each engine: fully passing files 5 → 6; QuickJS observed passes 1,425 → 1,494 with 24 file timeouts, JSC 1,111 → 1,173 with 24, browser 1,330 → 1,408 with 25.
- The offline app matrix passes all 24 install/start stages for Express 5.1.0, Koa 3.0.1, Hono 4.10.2 and Fastify 5.6.1. HMR passes all six Chromium/WebKit and engine combinations.
- TLS, QUIC, Unix sockets and subprocess-dependent fixtures stay separate from the portable HTTP adapters.
