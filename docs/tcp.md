# TCP on the host ABI

`node:net` Socket and Server, `net.connect`, `net.createConnection`,
`net.createServer`, `Bun.connect`, and `Bun.listen` share the TCP handles already
used by Bun.serve, HTTP previews, and WebSockets. QuickJS and JavaScriptCore use
the native wasmtime launcher's TCP sockets. The browser-engine Node host uses
Node sockets. In a web browser, all three engines use guest loopback pipes.

Sockets extend Duplex. They buffer writes made before connection completion,
report connection failure before emitting `connect`, buffer paused reads,
decode split characters with StringDecoder, count bytes, and support timeouts,
reference control, and write-side shutdown. A socket can receive a reply after
calling `end`. Server close callbacks wait for accepted connections to close.

HTTP upgrade listeners receive a Socket and the bytes already read after the
header. The HTTP client also supports upgrade responses. The published `ws`
8.18.3 client and server run over these sockets without package changes.
`scripts/test-net-ws.sh` copies the pinned package into a disposable directory
and checks a message exchange, close handshake, premature EOF and oversized
upgrade responses on all three engines.
Install its dependencies with `bun install --cwd docs/bun-test-suite/dependencies
--ignore-scripts --linker hoisted --frozen-lockfile` first.

The address helpers work without a networking host. They include Bun's IP
predicates, BlockList address/range/subnet rules, SocketAddress, normalized
connect arguments, and the default address-family settings used by Node's test
common module. The legacy `Bun.jest` entry point exposes the existing test API
so Bun's Node wrappers can collect their tests.

## Browser and adapter limits

A browser can connect a guest client to a guest listener in the same worker.
Its local pipes preserve FIN in each direction and bound queued bytes to 1 MiB
per direction. Connecting to a missing guest listener fails with ECONNREFUSED.
Raw outbound TCP to the internet fails with ENOTSUP because browsers have no
raw TCP socket API. This does not restrict fetch or the existing WebSocket
preview relay.

TLS sockets, Unix sockets, native file descriptors, keepalive tuning, and local
address/port binding for outbound connections are not implemented. The native
host resolves and connects addresses itself. With a BlockList, outbound
hostnames are rejected with ERR_IP_BLOCKED before opening a handle, because
the host ABI cannot expose the resolved address for validation before dialing.
This includes localhost and legacy numeric spellings such as 127.1. Supply a
literal IP, or a custom lookup that returns a literal IP, to apply the rules
to that address. The address-family defaults are
retained for the Node API, but do not add Node's timed Happy Eyeballs algorithm
to that host. `setNoDelay`, `setKeepAlive`, and corking return the socket; the
native host already disables Nagle's algorithm. These are compatibility
methods, not implementations of kernel tuning or write batching.

## Reproduce the comparison

Run heavy commands through the machine's admission wrapper. Build the launcher
and all three wasm artifacts first, using private target directories. Run
`scripts/test.sh --no-build --engine ENGINE`, `scripts/test-web.sh`, and
`scripts/test-net-ws.sh`. Browser networking checks also execute the TCP,
Bun callback, and HTTP upgrade fixtures in Chromium and WebKit.

The focused upstream selection is `js/node/net js/bun/net`, plus these explicit
Node assertion scripts under `js/node/test/parallel/`:

- `test-net-isip.js`
- `test-net-isipv4.js`
- `test-net-isipv6.js`
- `test-net-blocklist.js`
- `test-net-autoselectfamily-attempt-timeout-default-value.js`

Pass these paths to `scripts/bun-suite.sh --network loopback --jobs 1 --engine
ENGINE --dependencies docs/bun-test-suite/dependencies/node_modules --output
RESULT.json`. Explicitly selected assertion scripts run with `bun run`; their
successful exit establishes a passing file, with no invented test count.
Discovered Bun test files retain the existing test-report criteria.

Gaps remained in read callbacks, constructors, options and the address contract when this was measured. The adapter supports
working TCP and WebSocket exchanges; it does not claim complete Node net
conformance.

## TCP review regressions

`tests/fixtures/net-review` covers pipe backpressure and forwarding-listener
cleanup, connection-attempt cancellation, write callbacks before connection
and under blocked host writes, cross-chunk read sizes and EOF, timeout
cancellation, premature upgrade EOF, header limits and a large valid upgrade
head, and hostname BlockList enforcement. The HTTP response header limit is
`http.maxHeaderSize`, 16 KiB by default, or the request maxHeaderSize option.
Bytes after the header terminator remain the upgrade head and do not consume
that limit. EOF before a complete response fails once with ECONNRESET; header
overflow fails once with HPE_HEADER_OVERFLOW. Handshake listeners are removed
before the socket is handed to the upgrade listener.

Run `scripts/test.sh --no-build --engine ENGINE net-review` and
`scripts/test-net-ws.sh` against rebuilt artifacts. The regression commit
precedes the fix, so the same tests can reproduce the reviewed failures.
