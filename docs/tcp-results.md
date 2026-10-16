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
