# TCP compatibility results

Measured on 2026-10-16 against unchanged Bun source
`ddab8382bdf6b02f22653758d901fb83ceb85aa8`.

The selection contains 23 Bun test files and five explicit Node assertion
scripts. Assertion scripts add a passing file on successful exit, with no
invented test count. All five failed while loading Node common before this
change. All five now finish on every engine.

| Engine | Passing files before | After | Observed tests before | After | Node scripts | File timeouts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| quickjs | 3 | 9 | 27 | 180 | 0 -> 5 | 0 -> 1 |
| jsc | 3 | 9 | 28 | 179 | 0 -> 5 | 0 -> 1 |
| browser | 3 | 9 | 26 | 180 | 0 -> 5 | 1 -> 1 |

No file that fully passed before becomes failing. The new passes include
all 66 SocketAddress tests and newly collected Node net tests. More tests
also reach later failures. The QuickJS and JSC timeout is in
`js/node/net/node-net.test.ts`, which previously failed collection on the
missing BlockList export. These are bounded observations, not a claim
that the complete upstream net suites pass.

Each file has a 15-second limit and each test initially has a two-second
limit. Test processes have private loopback network namespaces. The runner,
upstream source, and dependency hashes match between controls and results.
Wasm and host hashes are retained in the raw JSON.

Reproduce the selection with the commands in [TCP support](tcp.md). Raw
`before-final-*.json` and `after-rebase-*.json`, JSONL checkpoints, gate
logs, and commands remain under `/work/reports/bun-wasm-tcp-2026-10-16/`
until coordinator review is accepted.

## Remaining QuickJS files

A skipped or empty file is excluded below. First diagnostics can hide later
failures. Use a fresh output path and `--jobs 1 --timeout 60` with the exact
file to investigate one row.

| File under test/ | Observed passes | Failures | First diagnostic |
| --- | ---: | ---: | --- |
| `js/bun/net/socket-dns-error.test.ts` | 20 | 4 | error: expect(received).toEqual(expected) |
| `js/bun/net/socket-retention.test.ts` | 4 | 3 | error: Bun.serve TLS is not supported by this networking host |
| `js/bun/net/socket-syscall-fault.test.ts` | 0 | 1 | SyntaxError: Could not find export 'socketFaultInjection' in module 'bun:internal-for-testing' |
| `js/bun/net/socket.test.ts` | 0 | 1 | SyntaxError: Could not find export 'createSocketPair' in module 'bun:internal-for-testing' |
| `js/bun/net/tcp-server.test.ts` | 8 | 2 | error: expect(received).toBe(expected) |
| `js/bun/net/tls-fatal-error-closes.test.ts` | 0 | 1 | SyntaxError: Could not find export 'RedisClient' in module 'bun' |
| `js/bun/net/tls-reject-before-client-cert.test.ts` | 0 | 1 | SyntaxError: Could not find export 'RedisClient' in module 'bun' |
| `js/bun/net/unix-socket-long-path.test.ts` | 0 | 4 | error: expect(received).toEqual(expected) |
| `js/bun/net/unix-socket-unlink.test.ts` | 0 | 9 | error: Unix sockets and TLS sockets are not supported in bun-wasm |
| `js/node/net/blocklist-gc.test.ts` | 0 | 1 | error: expect(received).toBe(expected) |
| `js/node/net/handle-leak.test.ts` | 0 | 1 | error: Unix sockets are not supported in bun-wasm |
| `js/node/net/net-mongodb-pattern-leak.test.ts` | 1 | 1 | error: tls.createServer is not supported in bun-wasm: WASI has no network access |
| `js/node/net/net-syscall-fault.test.ts` | 0 | 1 | SyntaxError: Could not find export 'socketFaultInjection' in module 'bun:internal-for-testing' |
| `js/node/net/node-net-allowHalfOpen.test.js` | 0 | 3 | error: Executable not found in bun-wasm: null |
| `js/node/net/node-net-server.test.ts` | 19 | 8 | error: expect(received).toStrictEqual(expected) |
| `js/node/net/node-net.test.ts` (file timeout) | 30 | 39 | error: expect(received).toBe(expected) |
| `js/node/net/server.spec.ts` | 27 | 13 | TypeError: class constructors must be invoked with 'new' |
| `js/node/net/socket-reconnect-live.test.ts` | 2 | 1 |   ^ this test timed out after 2000ms. |

## Server-file repeat control

The review comparison has one fewer observed pass in QuickJS and JSC, in
`js/node/net/node-net-server.test.ts`. Its drop race and half-open child-loop
cases were rerun three times on both the reviewed and fixed artifacts, with
the same two-second test budget and a 60-second outer file deadline. The
results below are observed pass ranges for that file, not additional suite
passes. Full records retain the failing test names.

quickjs: before 18..18, after 17..18

jsc: before 18..18, after 17..18

Repeat with the focused suite command and this exact file path. Raw pairs
are retained as `paired-server-*.json` in the review report.

## Review corrections

The final regression fixture runs fourteen checks for the eight review blockers.
Thirteen checks fail on each reviewed engine; the valid large upgrade head
control passes. All fourteen pass after the fix on each engine. The actual ws
8.18.3 package reproduces empty EOF, partial EOF and split header overflow on
each reviewed artifact and emits error and close after the fix.

| Engine | Files passing before / after | Tests passing before / after | Previously passing files lost |
| --- | ---: | ---: | ---: |
| quickjs | 9 / 9 | 179 / 178 | 0 |
| jsc | 9 / 9 | 180 / 179 | 0 |
| browser | 9 / 9 | 180 / 180 | 0 |

Each selection contains 28 upstream files, including the five previously
blocked Node assertion scripts. Passing-file preservation is checked from the
runner records. These bounded results retain the documented remaining gaps.

The native Node host receive buffer remains outside this correction. The pipe
regression uses a separately paused native TCP peer and asserts bounded guest
queues and stopped guest reads. It does not claim the host receive buffer is
bounded.

Review logs, artifact hashes and commands are retained in
`/work/reports/bun-wasm-tcp-review-2026-10-16/` until coordinator review is
accepted. Reproduce with `scripts/test.sh --no-build --engine ENGINE net-review`
and `scripts/test-net-ws.sh [WASM_DIR]`.

## Native accept-close correction

The paired server controls exposed ECONNRESET in the half-open child. The
native accept loop discarded a just-accepted socket if listener close had
already started. Dropping it with unread bytes resets the peer. A deterministic
native test queues bytes before that branch and reproduces ConnectionReset.
The fix sends that socket through the existing connection close/drain path.
All native host unit tests and all three full fixture gates pass afterward.
The browser transport and the ABI are unchanged.

The following final census uses that rebuilt launcher. The earlier paired
controls above retain the original launcher and their original records.

| Engine | Files passing before / final | Observed passes before / final |
| --- | ---: | ---: |
| quickjs | 9 / 9 | 179 / 180 |
| jsc | 9 / 9 | 180 / 179 |
| browser | 9 / 9 | 180 / 180 |

The drop-event case also fails on reviewed JSC artifacts in the paired
controls. The existing adapter emits peer address fields instead of Node
local/remote drop fields. That remaining address-contract gap predates these
fixes; the original census and repeated controls are retained separately.

## Multi-destination pipe correction

The round-two review found that each destination independently resumed its
source on drain. With one native peer paused and another receiving data, the
blocked guest write queue grew to 11,534,336 bytes on QuickJS and JSC, and
11,603,968 bytes on the browser engine. The allowed bound in this fixture is
66,560 bytes, the destination high-water mark plus one TCP delivery.

The source now owns the blocked pipe records. Drain and cleanup release only
their own record, and reads resume only after every blocked pipe has released.
`unpipe(destination)` removes the forwarding listeners and releases that pipe.
Destroy and finish use the same idempotent cleanup. A deferred resume checks
that the source is live and still has a pipe before reading again.

Reproduce with `scripts/test.sh --no-build --engine ENGINE net-pipe-fanout`.
The fixture uses an independently paused native TCP peer and a second,
draining destination. It checks the write bound and stopped reads, then checks
release through drain, unpipe and destroy. Each release must let the remaining
receiver get the complete payload. Detached destinations receive no later
writes, and finished pipes remove their listeners. The drain and unpipe cases
fail on every reviewed engine; the destroy case is a passing baseline control.

Round-two logs and artifact hashes are retained in
`/work/reports/bun-wasm-tcp-fanout-2026-10-16/` until coordinator acceptance.

## CLI preview ports, 2026-10-23

The CLI helper no longer binds virtual guest port numbers in the real host
namespace. Each preview binds port zero and prints its allocated URL.
The focused `web/tests/cli-preview.test.ts` uses real Waffle pipes and real
Bun HTTP servers. Before the fix, the first preview throws EADDRINUSE when
an existing server owns its guest port. After the fix, two helpers forward
requests independently through the same guest port, the existing server still
answers, and both preview ports can be rebound after teardown.
This host-only change does not require a new guest artifact.

## Socket callbacks and reconnect options, 2026-10-23

At main `5fa3a24f`, three focused adapter tests fail because no onread callback
is invoked. After the correction, four tests pass with 21 assertions over the
production adapters, waiter scheduler, real Duplex and installed Waffle TCP
pipes. They cover fixed buffers, generated buffers, callback-requested pause,
a paused live reconnect, byte counts, old-handle closure and constructor options.
These are focused checks, not a replacement census of the upstream suites.

Run `bun test web/tests/node-net-onread.test.ts`. The real-guest companion is
`tests/fixtures/net-onread`, selected with `scripts/test.sh --no-build --engine
ENGINE net-onread`. Before/after logs and guest evidence are retained in
`/work/reports/wave-20261022/bun-wasm/tcp-queue/` for coordinator review.
