# Failure groups

Each row describes the first observed blocker. Subsystem assignments marked 'needs reproduction' are provisional; they do not establish that every test needs the same fix. Full assignments and confidence are in [failures.tsv](failures.tsv).

| Category | First blocker / topic | Files | Example file | Test | Error |
|---|---|---|---|---|---|
| a | native addons or FFI | 62 | js/bun/ffi/cc.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'JSCallback' in module 'bun:ffi' |
| a | native addons, threads, watching or OS-only facilities | 8 | cli/bun.test.ts | bun > per-stream color detection > piped stdout stays plain when stderr is a tty | error: bun:ffi.dlopen is not supported in bun-wasm: no native libraries in wasm |
| a | network operations beyond the current host ABI | 14 | js/bun/dns/resolve-dns.test.ts | dns > lookup() [backend: system] > localhost > {"options":{"backend":"system"}} | error: Bun.dns.lookup is not supported in bun-wasm: WASI has no network access |
| b | CLI options, environment, cwd and script launching | 5 | cli/lint/git.test.ts | bun lint > --staged selects the files whose staged version differs from HEAD | error: Executable not found in bun-wasm: git |
| b | bundling, compiling, generated program output | 6 | bundler/bundler_compile_autoload.test.ts | bundler > compile/AutoloadDotenvDefault | error: Executable not found in bun-wasm: /tmp/bun-build-tests/bun-1UmV34/compile/AutoloadDotenvDefault/out |
| b | external echo executable in normal-array control | 1 | js/bun/spawn/spawn-large-array-length.test.ts | spawn with spoofed array length > Bun.spawnSync still works with normal arrays | error: expect(received).toBe(expected) |
| b | network server/client behavior in a child program | 5 | js/bun/http/bun-serve-html.test.ts | serve html | error: Child process IPC is not supported in bun-wasm |
| b | package manager commands and lifecycle scripts | 4 | cli/install/bun-install-git-deps.test.ts | (unnamed) | error: Executable not found in bun-wasm: git |
| b | process lifecycle, exit and signal handling | 20 | js/bun/http/fetch-abort-ssl-context-eviction.test.ts | aborting fetches whose custom SSL context was evicted does not crash | error: bun-wasm child concurrency limit reached (4 active children) |
| b | runtime behavior or regression fixture in a child program | 35 | bake/dev-and-prod.test.ts |  DEV:dev-and-prod-1: define config via bunfig.toml | error: Child process IPC is not supported in bun-wasm |
| b | test runner output, hooks, assertions and exit status | 5 | bake/dev/react-spa.test.ts |  DEV:react-spa-1: react in html | error: Unknown install option: --linker=hoisted |
| c | boxed String paths from harness.tempDir | 1 | js/bun/resolve/png/test-png-import.test.js | png import | TypeError: The "paths[0]" property must be of type string, got object |
| c | test runner boolean or snapshot matchers | 1 | js/node/path/matches-glob.test.ts | path.posix.matchesGlob(path, glob) > path 'foo.js' matches pattern '*.js' | TypeError: not a function |
| c | test runner helpers or matcher methods | 3 | js/bun/module-graph/module-graph-isolation.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'setSystemTime' in module 'bun:test' |
| c | uninstalled suite dependency, setup work before API triage | 49 | bundler/bundler_edgecase.test.ts | <collection/hook/exit; no named failure> | error: Cannot find package 'aws-cdk-lib' from '/bun/test/bundler/bundler_edgecase.test.ts' |
| d | Bun shell parser and execution | 63 | bake/dev/production.test.ts | production > works with sourcemaps - error thrown in React component | error: Bun.$ is not supported in bun-wasm: WASI has no processes |
| d | CLI option or command implementation | 46 | bundler/bundler_bun.test.ts | bundler > bun/bytecode-depth-cli | error: Bundle Failed |
| d | ES module mocking and loader invalidation | 7 | js/bun/test/mock/6874/A.test.ts | <collection/hook/exit; no named failure> | error: mock.module() is not supported in bun-wasm yet |
| d | HTTP/server/fetch/WebSocket semantics | 180 | bake/dev/ecosystem.test.ts |  DEV:ecosystem-1: svelte component islands example | <see JSON excerpt; no error line> |
| d | Node's test API adapter | 3 | internal/runner-junit.test.ts | parseJunitFileSuites reads the report bun test --parallel --reporter=junit writes | error: expect(received).toContain(expected) |
| d | Node/Web stream semantics | 29 | cli/install/symlink-path-traversal.test.ts | symlink path traversal protection > rejects symlink targets that climb above the package root before | error: expect(received).toContain(expected) |
| d | SQLite API compatibility | 4 | js/bun/sqlite/column-types.test.js | SQLite Statement column types > reports correct column types for a variety of data types | TypeError: cannot read property 'columns' of undefined |
| d | TLS or HTTP/2 | 84 | cli/install/bun-install-stalled-tls.test.ts | each retry after a timeout is announced > package manifest | error: expect(received).toEqual(expected) |
| d | bundler options, plugins or compiler output | 71 | bake/app-options.test.ts | Bun.serve({ app }) rejects wrong-typed framework options | error: expect(received).toMatchInlineSnapshot(expected) |
| d | crypto algorithms and WebCrypto | 23 | js/bun/crypto/cipheriv-decipheriv.test.ts | should encrypt & decrypt using update & final interface | error: crypto.createCipheriv is not supported in bun-wasm: this Node crypto operation is not implemented |
| d | data parser/serializer semantics | 14 | cli/format/toml-layout.test.ts | TOML layout > formats every case without errors, and --check passes afterwards | error: expect(received).toEqual(expected) |
| d | database, Redis or S3 clients | 128 | js/bun/image/image.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'S3Client' in module 'bun' |
| d | filesystem API semantics | 2 | js/bun/util/filesystem_router.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'FileSystemRouter' in module 'bun' |
| d | test runner/assertion or runtime semantics | 720 | cli/bunfig-test-options.test.ts | bunfig.toml test options > randomize with seed produces consistent order | error: expect(received).not.toEqual(expected) |
| d | timeout, first unblock and rerun without reducing it to an API verdict | 5 | js/node/buffer-indexof-worstcase.test.ts | <collection/hook/exit; no named failure> | <see JSON excerpt; no error line> |
| d | unresolved runtime/module semantics, inspect the recorded failure first | 72 | bake/hmr-socket-protocol.test.ts | a duplicate testing-batch frame (H) during an in-flight bundle closes the socket instead of aborting |   ^ this test timed out after 2000ms. |
| e | private native-engine/compiler instrumentation has no portable equivalent | 93 | bake/deinitialization.test.ts | dev server deinitializes itself | SyntaxError: Could not find export 'getDevServerDeinitCount' in module 'bun:internal-for-testing' |
| f | passes on browser | 16 | js/bun/crypto/wpt-webcrypto.generateKey.test.ts | <collection/hook/exit; no named failure> | <see JSON excerpt; no error line> |
| f | passes on browser, jsc | 3 | js/bun/jsc/webkit-upgrade-ccdcb8a026.test.ts | WebKit ccdcb8a026 upgrade > Atomics.isLockFree uses ToIntegerOrInfinity instead of wrapping to int32 | ReferenceError: Atomics is not defined |
| f | passes on jsc | 4 | js/bun/jsc/webkit-upgrade-8c4fd56347.test.ts | WebKit 8c4fd56347 upgrade > Promise.try returns a native promise as-is (7f38ebbabf) | error: expect(received).toBe(expected) |

## Regressions from the previous baseline

QuickJS is the sole comparable baseline by matched file selection; JSC and browser remain non-comparable. Changed runner, suite, and supplemental-dependency hashes prevent an isolated runtime-gain claim. See [README.md](guide.md#historical-and-current-observations) and `summary.json` for selections and provenance.

## Timeout index

Every row has a 15-second wall deadline. A completed report can also come from a child test command; it does not prove that the parent completed. Reproduce with the README command and the exact file path below. See [investigations.md](investigations.md) for longer reruns and diagnoses.

| File | Change | Report observed | Passes | Last failure observed | First error |
|---|---|---|---|---|---|
| bundler/bundler_splitting.test.ts | existing | False | 161 | bundler > splitting/ModulePreloadDisabled | error: Bundle Failed |
| cli/hot/hot.test.ts | existing | False | 0 | should not remap against a stale sourcemap after a partial-file reload | error: expect(received).toContain(expected) |
| cli/install/bun-security-scanner-matrix-without-node-modules.test.ts | existing | False | 0 | bun remove > is-even > --linker=isolated > (scanner: npm) > (bun.lock exists: false) > (advisories: fatal) > (no-TTY) > 0530 (without modules) | error: expect(received).toEqual(expected) |
| cli/test/isolation.test.ts | existing | False | 9 | --isolate: a finished file's late completions do not run in the next file > --parallel | error: expect(received).toContain(expected) |
| cli/test/parallel.test.ts | existing | False | 0 | --parallel --bail stops dispatching new files after threshold | error: expect(received).not.toContain(expected) |
| js/bun/bun-object/deep-equals-temporal.test.ts | existing | False | 16 | Bun.deepEquals on Temporal values (strict: false) > different values of the same class are not equal (case 21) | RangeError: Offset +02:00 is invalid for 2024-06-15T12:34:56 in Europe/Berlin |
| js/bun/crypto/wpt-webcrypto.generateKey.test.ts | existing | False | 477 | no named failure | no error captured |
| js/bun/gc/gc-controller-cadence.test.ts | existing | False | 3 | idle release > an idle collection finishes while the program is parked | error: expect(received).toContain(expected) |
| js/bun/glob/leak.test.ts | existing | False | 1 | no named failure | no error captured |
| js/bun/http/async-iterator-stream.test.ts | existing | False | 1 | Bun.serve: an iterator with next(), return() and throw() is closed with return() > behind tee(), the other branch cancelled > when the client hangs up | error: expect(received).toBe(expected) |
| js/bun/http/bun-serve-file.test.ts | existing | False | 1 | Response(Bun.file(FIFO)) frames the body as chunked, not Content-Length: 0 | error: expect(received).toBe(expected) |
| js/bun/http/bun-serve-html-build-holds-server.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/http/bun-server.test.ts | existing | False | 10 | should be able to async upgrade using custom protocol | error: expect(received).toBe(expected) |
| js/bun/http/hspec.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/http/request-smuggling.test.ts | existing | False | 6 | SPILL.TERM - invalid chunk terminators > rejects zero-chunk terminator with CR but wrong second byte | error: expect(received).toContain(expected) |
| js/bun/http/serve-async-stream-client-abort.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/http/serve-body-leak.test.ts | existing | False | 0 | request body leak (http2: true) > (unnamed) | error: Child process IPC is not supported in bun-wasm |
| js/bun/http/serve-direct-readable-stream.test.ts | existing | False | 0 | HTTPResponseSink displays correct message | TypeError: First parameter has member 'type' that 'direct' is not a valid enumeration value for ReadableStreamType |
| js/bun/http/serve-http2-lifecycle.test.ts | existing | False | 0 | Bun.serve http2 lifecycle > graceful stop: GOAWAY, in-flight stream completes, process exits | error: fixture exited before listening: 37 \|     req.cookies.set("seen", (req.cookies.get("seen") ?? "") + "x"); |
| js/bun/http/serve-pending-promise-abort-leak.test.ts | existing | False | 1 | resolve() inside abort handler is handled safely | error: expect(received).toBe(expected) |
| js/bun/http/serve-response-stream-sink-leak.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/http/serve-stream-reject-flush-leak.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/http/serve.test.ts | existing | False | 89 | should allow use of custom timeout | error: expect(received).toContain(expected) |
| js/bun/module-graph/module-graph-workers.test.ts | existing | False | 0 | ModuleGraph and workers, B: a worker hosts the graph > the graph has nothing open, in a node Worker: the graph's code throws, onError records it | error: expect(received).toEqual(expected) |
| js/bun/spawn/spawn-signal.test.ts | existing | False | 2 | spawnSync AbortSignal throws if already aborted | error: expect(received).toEqual(expected) |
| js/bun/terminal/terminal-platform-gaps.test.ts | existing | False | 0 | Bun.Terminal platform behaviour > SAME: child stdout reaches data callback | TypeError: not a function |
| js/bun/test/expect.test.js | existing | False | 49 | expect() > deepEquals derived strings and strings | error: expect(received).toThrow() |
| js/node/buffer-indexof-worstcase.test.ts | existing | False | 0 | no named failure | no error captured |
| js/node/fs/abort-signal-leak-read-write-file.test.ts | existing | False | 0 | no named failure | no error captured |
| js/node/http/node-http-agent-tls-options.test.mts | existing | False | 0 | https.request agent TLS options inheritance > option precedence (matches Node.js) > agent.options takes precedence over direct options |   ^ this test timed out after 2000ms. |
| js/node/http/node-http-connect.test.ts | existing | False | 0 | HTTP server CONNECT > should handle CONNECT with invalid target |   ^ this test timed out after 2000ms. |
| js/node/http/node-http-req-complete.test.ts | existing | False | 9 | a HEAD request with Content-Length has a body |   ^ this test timed out after 2000ms. |
| js/node/http/node-http-req-socket-pause.test.ts | existing | False | 5 | reading a request body does not reopen the read gate that queued pipelined responses closed |   ^ this test timed out after 2000ms. |
| js/node/http/node-http-server-close-drain.test.ts | existing | False | 2 | server.close() does not reap a connection that still receives a Content-Length request body, called in the handler | error: expect(received).toBe(expected) |
| js/node/http/node-http-server-timeouts.test.ts | existing | False | 2 | node:http server timeout enforcement > with pipelining, 'timeout' goes to the incoming request, the response that owns the socket, then the server |   ^ this test timed out after 2000ms. |
| js/node/http/node-https-agent-checkserveridentity-reuse.test.ts | existing | False | 0 | https.Agent({ keepAlive: true }) and a request's own checkServerIdentity > an Agent-level callback still shares its pooled socket |   ^ this test timed out after 2000ms. |
| js/node/module/node-module-module.test.js | existing | False | 3 | node-module-module > module.Module works | error: expect(received).toHaveLength(expected) |
| js/node/net/double-connect.test.ts | existing | False | 0 | no named failure | no error captured |
| js/node/net/node-net.test.ts | existing | False | 29 | Socket fd adoption > ignores fd / readable / writable that are not own properties of the options | error: expect(received).toBe(expected) |
| js/node/process/process.test.js | existing | False | 17 | handling N rejected promises is O(N) > while they wait to be reported, in no particular order | error: process.env is not an object |
| js/node/stream/web-stream-state.test.ts | existing | False | 2 | a stream that a native consumer takes > the stream of a node:stream Readable body > closes after HTMLRewriter takes it to the end |   ^ this test timed out after 2000ms. |
| js/node/url/pathToFileURL.test.ts | existing | False | 0 | no named failure | no error captured |
| js/web/fetch/fetch-response-finalizer-sweep.test.ts | existing | False | 0 | no named failure | no error captured |
| js/web/fetch/fetch.stream.test.ts | existing | False | 6 | fetch() with streaming > can handle fixture empty x big text | error: expect(received).toBe(expected) |
| js/web/fetch/wasm-streaming.test.ts | existing | True | 22 | WebAssembly.compileStreaming > Content-Type matching > rejects a missing Content-Type | error: expect(received).toThrow(expected) |
| js/web/request/request-clone-leak.test.ts | existing | False | 0 | no named failure | no error captured |
| js/web/request/request-method-getter.test.ts | existing | False | 0 | new Request(http://localhost:3000/).clone().method doesnt create a new JSString every time | error: expect(received).toBeLessThan(expected) |
| js/web/timers/setImmediate2.test.ts | existing | False | 0 | no named failure | no error captured |
| js/web/timers/setInterval.test.js | existing | False | 4 | setInterval canceling with unref, close, _idleTimeout, and _onTimeout | error: Expected elapsed time to be less than 180 |
| js/web/websocket/websocket-upgrade.test.ts | existing | False | 0 | no named failure | no error captured |
| regression/issue/42989.test.ts | existing | False | 0 | no named failure | no error captured |


## Ranked next fixes

The two former catch-all buckets now break down into the 25 most common normalized first-error signatures. Counts are failing suite files, and locations come from the first throwing frame in the bounded QuickJS record. The source location is the test or harness frame that throws; the suspected location names the runtime area to inspect.

1. **error: expect(received).toBe(expected)**. Unblocks 151 suite files.
   Throwing source `[eval]:3`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/format/bunfig.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/format/bunfig.test.ts`.

2. **TypeError: not a function**. Unblocks 80 suite files.
   Throwing source `js/bun/test/fake-timers/sinonjs/helpers/setup-tests.ts:14`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/GHSA-pfwx-36v6-832x.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/engine_quickjs.rs:238`. Example `cli/install/GHSA-pfwx-36v6-832x.test.ts`.

3. **error: expect(received).toContain(expected)**. Unblocks 68 suite files.
   Throwing source `cli/install/dummy.registry.ts:63`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/check/check.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/check/check.test.ts`.

4. **error: expect(received).toEqual(expected)**. Unblocks 65 suite files.
   Throwing source `js/deno/harness.ts:105`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/format/oxfmt-cli/oxfmt-cli.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/format/oxfmt-cli/oxfmt-cli.test.ts`.

5. **error: expect(received).toMatchInlineSnapshot(expected)**. Unblocks 37 suite files.
   Throwing source `cli/install/bun-install-patch.test.ts:155`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/bun-install-patch.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/install/bun-install-patch.test.ts`.

6. **error: expect(received).toThrow(expected)**. Unblocks 26 suite files.
   Throwing source `js/bun/cron/in-process-cron.test.ts:7`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/cron/in-process-cron.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `js/bun/cron/in-process-cron.test.ts`.

7. **error: expect(received).not.toContain(expected)**. Unblocks 18 suite files.
   Throwing source `harness.ts:1717`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/bun-install-link-path.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/install/bun-install-link-path.test.ts`.

8. **<no error captured>**. Unblocks 17 suite files.
   Throwing source `bundler/bun-build-compile-wasm.test.ts:?`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bundler/bun-build-compile-wasm.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/spawn.js:370`. Example `bundler/bun-build-compile-wasm.test.ts`.

9. **^ this test timed out after Nms.**. Unblocks 14 suite files.
   Throwing source `bake/hmr-socket-protocol.test.ts:393`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/hmr-socket-protocol.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `bake/hmr-socket-protocol.test.ts`.

10. **AssertionError: Expected values to be strictly equal:**. Unblocks 11 suite files.
   Throwing source `js/bun/perf_hooks/histogram.test.ts:10`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/perf_hooks/histogram.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `js/bun/perf_hooks/histogram.test.ts`.

11. **SyntaxError: Unexpected end of JSON input**. Unblocks 11 suite files.
   Throwing source `cli/lint/bun-rules.test.ts:2267`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/lint/bun-rules.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`. Example `cli/lint/bun-rules.test.ts`.

12. **error: Expected process to exit with code 0 but got 1**. Unblocks 7 suite files.
   Throwing source `js/bun/resolve/bun-lock.test.ts:26`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/resolve/bun-lock.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/spawn.js:370`. Example `js/bun/resolve/bun-lock.test.ts`.

13. **error: Network is unreachable (os error N)**. Unblocks 7 suite files.
   Throwing source `integration/expo-app/expo.test.ts:21`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" integration/expo-app/expo.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/net.js:1`. Example `integration/expo-app/expo.test.ts`.

14. **error: expect(received).toMatch(expected)**. Unblocks 7 suite files.
   Throwing source `cli/install/public-hoist-pattern.test.ts:38`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/public-hoist-pattern.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/install/public-hoist-pattern.test.ts`.

15. **error: expect(received).toMatchObject(expected)**. Unblocks 7 suite files.
   Throwing source `cli/inspect/inspect.test.ts:263`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/inspect/inspect.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/inspect/inspect.test.ts`.

16. **ReferenceError: HTMLRewriter is not defined**. Unblocks 6 suite files.
   Throwing source `js/web/html/html-rewriter-doctype.test.ts:9`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/web/html/html-rewriter-doctype.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/web.js:1`. Example `js/web/html/html-rewriter-doctype.test.ts`.

17. **error: expect(received).toBeGreaterThan(expected)**. Unblocks 6 suite files.
   Throwing source `cli/install/bun-install-env-file.test.ts:83`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/bun-install-env-file.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/install/bun-install-env-file.test.ts`.

18. **error: expect(received).toMatchSnapshot(expected)**. Unblocks 6 suite files.
   Throwing source `cli/install/migration/npm-arborist.test.ts:?`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/migration/npm-arborist.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `cli/install/migration/npm-arborist.test.ts`.

19. **ReferenceError: Worker is not defined**. Unblocks 5 suite files.
   Throwing source `js/bun/util/bun-isMainThread.test.js:13`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/util/bun-isMainThread.test.js`.
   Suspected location `crates/bunwasm-runtime/src/js/spawn.js:1`. Example `js/bun/util/bun-isMainThread.test.js`.

20. **SyntaxError: Could not find export 'X509Certificate' in module 'node:crypto'**. Unblocks 5 suite files.
   Throwing source `js/web/websocket/websocket-client.test.ts:?`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/web/websocket/websocket-client.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`. Example `js/web/websocket/websocket-client.test.ts`.

21. **SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'**. Unblocks 5 suite files.
   Throwing source `js/bun/util/heap-snapshot.test.ts:?`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/util/heap-snapshot.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`. Example `js/bun/util/heap-snapshot.test.ts`.

22. **error: expect(received).toThrow()**. Unblocks 5 suite files.
   Throwing source `js/bun/console/console-table.test.ts:29`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/console/console-table.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `js/bun/console/console-table.test.ts`.

23. **SyntaxError: Could not find export '__decorateElement' in module 'bun:wrap'**. Unblocks 4 suite files.
   Throwing source `bundler/transpiler/decorator-metadata.test.ts:?`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bundler/transpiler/decorator-metadata.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`. Example `bundler/transpiler/decorator-metadata.test.ts`.

24. **TypeError: cannot read property 'html' of undefined**. Unblocks 4 suite files.
   Throwing source `js/bun/md/gfm-compat.test.ts:16`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/md/gfm-compat.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`. Example `js/bun/md/gfm-compat.test.ts`.

25. **^ this test timed out after Nms, before its done callback was called. If a done callback was not intended, remove the last parameter from the test callback function**. Unblocks 4 suite files.
   Throwing source `js/third_party/jsonwebtoken/claim-exp.test.js:?`. Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/third_party/jsonwebtoken/claim-exp.test.js`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`. Example `js/third_party/jsonwebtoken/claim-exp.test.js`.

## Ranked causes behind the assertion buckets

This analysis uses PR #39's immutable run at runtime commit `6e93c80c6f9bccc879990bedb999c3efdcd3166f` and suite revision `cd95fa7a13b3f13be73e512b38ec111c1c228084`. The source references below refer to that runtime revision. No runtime, suite fixture, scoreboard count, or category assignment in `failures.tsv` changes here.

The input is the 792 files in the two old catch-all topics, plus the 23 files classified as engine differences. 250 concrete causes account for 536 distinct files in this 815-file selection. All 424 files in the six requested buckets have a cause below. Counts describe observed blockers, not files guaranteed to pass after one fix. A file can have later independent failures.

The six bucket counts are regenerated from the committed TSV membership and the raw JSON's first diagnostic. They are 150, 80, 66, 65, 37, and 26. PR #39's prose quoted 151 for toBe and 68 for toContain. Those two numbers do not match this exact selection, so the named member lists below are the counting authority.

| Old first diagnostic | Files | Distinct causes | Files assigned below |
|---|---|---|---|
| `error: expect(received).toBe(expected)` | 150 | 110 | 150 |
| `TypeError: not a function` | 80 | 29 | 80 |
| `error: expect(received).toContain(expected)` | 66 | 49 | 66 |
| `error: expect(received).toEqual(expected)` | 65 | 52 | 65 |
| `error: expect(received).toMatchInlineSnapshot(expected)` | 37 | 19 | 37 |
| `error: expect(received).toThrow(expected)` | 26 | 19 | 26 |

Category `a` needs an OS capability outside the present host ABI. Category `b` needs a missing child-process capability. Category `c` is a bounded helper, validation, setup, or diagnostic change. Category `d` needs a larger implementation. Category `e` records an intentional exclusion with its reason. Category `f` has a measured engine comparison; its cause may be an engine builtin, the embedded polyfill, or the host backend. An `f` assignment alone does not identify which of those owns the defect.

Public error codes, argument validation, report labels, stable class names, and version normalization are compatibility work under `c`. Category `a` requires evidence of a missing capability needed by the tested operation. Category `e` requires an explicit capability or cost reason. Native wording, a private test helper, and an absent API do not automatically qualify. The `f` parser and disposal entries record measured differences without an automatic exclusion. These triage labels do not change the measured scoreboard.

### Platform and cost exclusions audited after review

All 25 ranked causes originally labelled `a` or `e` were checked against every member's complete raw log and the pinned suite/runtime source. That covers 51 original member files. The reviewed echo case adds one file from category `c`. 22 file labels changed. The revised ranking retains 30 excluded files across 13 causes, each with a missing tested capability or an explicit portability/maintenance cost below.

An absent export, a private-looking name, a test title mentioning GC or TTY, and a missing output marker do not establish an exclusion. Public argument validation and result-shape assertions remain fixable even when later parts of the file require OS facilities. The first failing operation controls the assigned label; later failures remain separate work.

The complete audit with full-log hashes is retained in `review-r1/exclusion-audit.json` in the analysis report directory. Regeneration verifies every source citation and raw-log hash, checks that every current `a`/`e` member has an audited capability/cost reason, and rejects classification drift. The source-level probe executes the pinned spawn factory against a mock host. It confirms ENOENT and zero host calls for bash and echo, null signalCode for a normal unsignalled return, and the pinned matcher's acceptance of an empty string for expect.any(String). The tested commands start no real OS child executable. Actual WASI observations remain in the unchanged baseline logs.

<details>
<summary>All 52 file decisions, including the three review corrections</summary>

| File | Label before → after | Raw observation and decision | Pinned evidence |
|---|---|---|---|
| `js/bun/util/heap-snapshot.test.ts` | e → e | `SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'`. Truthful shallow-cell size needs private object-layout/backing-store instrumentation on JSC, QuickJS and browser engines. Engine exposes aggregate memory only; standard browser workers expose no per-object size API. Maintain no fabricated size adapter solely for private assertions. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-runtime/src/js/builtins.js:837](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L837) |
| `js/node/zlib/zlib-estimated-size-gc.test.ts` | e → e | `SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'`. Truthful shallow-cell size needs private object-layout/backing-store instrumentation on JSC, QuickJS and browser engines. Engine exposes aggregate memory only; standard browser workers expose no per-object size API. Maintain no fabricated size adapter solely for private assertions. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-runtime/src/js/builtins.js:837](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L837) |
| `js/web/abort/abort-signal-event-listener-leak.test.ts` | e → e | `SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'`. Truthful shallow-cell size needs private object-layout/backing-store instrumentation on JSC, QuickJS and browser engines. Engine exposes aggregate memory only; standard browser workers expose no per-object size API. Maintain no fabricated size adapter solely for private assertions. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-runtime/src/js/builtins.js:837](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L837) |
| `js/web/timers/performance-entries.test.ts` | e → e | `SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'`. Truthful shallow-cell size needs private object-layout/backing-store instrumentation on JSC, QuickJS and browser engines. Engine exposes aggregate memory only; standard browser workers expose no per-object size API. Maintain no fabricated size adapter solely for private assertions. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-runtime/src/js/builtins.js:837](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L837) |
| `js/web/websocket/websocket-pong-fragmented.test.ts` | e → e | `SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'`. Truthful shallow-cell size needs private object-layout/backing-store instrumentation on JSC, QuickJS and browser engines. Engine exposes aggregate memory only; standard browser workers expose no per-object size API. Maintain no fabricated size adapter solely for private assertions. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-runtime/src/js/builtins.js:837](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L837) |
| `js/bun/terminal/terminal-platform-gaps.test.ts` | a → a | `TypeError: not a function`. PTY master/slave descriptors and termios/ioctl control are not supplied by WASI preview1 or this host ABI. These tests request a real terminal transport, not a shell pipe. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [docs/host-abi.md:224](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L224); `test/js/bun/terminal/terminal-platform-gaps.test.ts:80 @cd95fa7a` |
| `js/bun/terminal/terminal-spawn.test.ts` | a → a | `TypeError: not a function`. PTY master/slave descriptors and termios/ioctl control are not supplied by WASI preview1 or this host ABI. These tests request a real terminal transport, not a shell pipe. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [docs/host-abi.md:224](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L224); `test/js/bun/terminal/terminal-spawn.test.ts:11 @cd95fa7a` |
| `js/bun/terminal/terminal.test.ts` | a → a | `TypeError: not a function`. PTY master/slave descriptors and termios/ioctl control are not supplied by WASI preview1 or this host ABI. These tests request a real terminal transport, not a shell pipe. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [docs/host-abi.md:224](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L224); `test/js/bun/terminal/terminal.test.ts:15 @cd95fa7a` |
| `js/node/tty.test.ts` | a → a | `  ^ this test timed out after 2000ms.`. The first timed-out test requests Bun.spawn terminal options and waits for PTY RESULT data. Its source explicitly requires openpty/ConPTY stdin; the later absent Bun.Terminal error corroborates missing terminal transport. Ordinary pipes do not implement termios/raw mode. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [docs/host-abi.md:224](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L224); `test/js/node/tty.test.ts:17 @cd95fa7a`; `test/js/node/tty.test.ts:70 @cd95fa7a` |
| `regression/issue/26286.test.ts` | a → a | `TypeError: not a function`. PTY master/slave descriptors and termios/ioctl control are not supplied by WASI preview1 or this host ABI. These tests request a real terminal transport, not a shell pipe. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [docs/host-abi.md:224](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L224); `test/regression/issue/26286.test.ts:15 @cd95fa7a` |
| `js/bun/udp/udp_socket.test.ts` | a → a | `error: expect(received).toBe(expected)`. The host exposes TCP stream/listen/address operations, not UDP bind/send/receive. The member source requires Bun.udpSocket or dgram.createSocket before its intended assertion. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789); [crates/bunwasm-runtime/src/js/bun.js:519](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L519) |
| `js/node/dns/dns-resolver-concurrent-timeout.test.ts` | a → a | `error: expect(received).toBe(expected)`. The host exposes TCP stream/listen/address operations, not UDP bind/send/receive. The member source requires Bun.udpSocket or dgram.createSocket before its intended assertion. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789); [crates/bunwasm-runtime/src/js/bun.js:519](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L519) |
| `js/node/dns/dns-tcp-bidirectional-poll.test.ts` | a → a | `error: expect(received).toBe(expected)`. The host exposes TCP stream/listen/address operations, not UDP bind/send/receive. The member source requires Bun.udpSocket or dgram.createSocket before its intended assertion. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789); [crates/bunwasm-runtime/src/js/bun.js:519](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L519) |
| `regression/issue/24157.test.ts` | a → a | `error: expect(received).toContain(expected)`. The host exposes TCP stream/listen/address operations, not UDP bind/send/receive. The member source requires Bun.udpSocket or dgram.createSocket before its intended assertion. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789); [crates/bunwasm-runtime/src/js/bun.js:519](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L519) |
| `regression/issue/28083.test.ts` | a → a | `error: expect(received).toContain(expected)`. The host exposes TCP stream/listen/address operations, not UDP bind/send/receive. The member source requires Bun.udpSocket or dgram.createSocket before its intended assertion. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789); [crates/bunwasm-runtime/src/js/bun.js:519](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L519) |
| `js/bun/webview/webview-chrome-disconnect.test.ts` | a → d | `error: expect(received).toEndWith(expected)`. The first failures are missing constructor or option validation. The disconnect fixture uses a local Bun.serve WebSocket CDP mock, and the pipe fixture substitutes a Bun script for Chrome. These controls do not require a native GUI or installed browser. Implement the public WebView API before attributing a later transport failure to the host. | [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449); `test/js/bun/webview/webview-chrome-disconnect.test.ts:92 @cd95fa7a` |
| `js/bun/webview/webview-chrome-pipe.test.ts` | a → d | `error: expect(received).toBe(expected)`. The first failures are missing constructor or option validation. The disconnect fixture uses a local Bun.serve WebSocket CDP mock, and the pipe fixture substitutes a Bun script for Chrome. These controls do not require a native GUI or installed browser. Implement the public WebView API before attributing a later transport failure to the host. | [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449); `test/js/bun/webview/webview-chrome-pipe.test.ts:27 @cd95fa7a` |
| `js/bun/webview/webview-chrome.test.ts` | a → d | `error: expect(received).toThrow(expected)`. The first failures are missing constructor or option validation. The disconnect fixture uses a local Bun.serve WebSocket CDP mock, and the pipe fixture substitutes a Bun script for Chrome. These controls do not require a native GUI or installed browser. Implement the public WebView API before attributing a later transport failure to the host. | [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449); `test/js/bun/webview/webview-chrome.test.ts:338 @cd95fa7a` |
| `js/bun/webview/webview.test.ts` | a → d | `error: expect(received).toThrow(expected)`. The first failures are missing constructor or option validation. The disconnect fixture uses a local Bun.serve WebSocket CDP mock, and the pipe fixture substitutes a Bun script for Chrome. These controls do not require a native GUI or installed browser. Implement the public WebView API before attributing a later transport failure to the host. | [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449); `test/js/bun/webview/webview.test.ts:69 @cd95fa7a` |
| `js/bun/spawn/spawn-pipe-read-error-leak.test.ts` | a → a | `error: expect(received).toEqual(expected)`. The tested libc dlopen/mmap or compile-and-call needs executable host machine code and a native foreign-call bridge. No host-library/foreign-call operation exists in the wasm32 guest ABI. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:863](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L863) |
| `js/bun/transpiler/transpiler-truncated-utf8.test.ts` | a → a | `error: expect(received).toEqual(expected)`. The tested libc dlopen/mmap or compile-and-call needs executable host machine code and a native foreign-call bridge. No host-library/foreign-call operation exists in the wasm32 guest ABI. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:863](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L863) |
| `regression/issue/15753.test.ts` | a → c | `error: expect(received).toContain(expected)`. All five raw failures already reject the input, but print CODE:undefined instead of ERR_DLOPEN_FAILED. Reporting the public rejection code needs no successful native addon load. The native ELF guard and library execution paths remain unmeasured. | `test/regression/issue/15753.test.ts:116 @cd95fa7a`; [crates/bunwasm-runtime/src/js/process.js:253](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L253) |
| `regression/issue/26249.test.ts` | a → a | `error: expect(received).toBe(expected)`. The tested libc dlopen/mmap or compile-and-call needs executable host machine code and a native foreign-call bridge. No host-library/foreign-call operation exists in the wasm32 guest ABI. | [docs/host-abi.md:76](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L76); [crates/bunwasm-runtime/src/js/builtins.js:863](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L863) |
| `js/bun/glob/scan.test.ts` | e → e | `TypeError: not a function`. Collector aggressiveness is JSC-private policy. Engine exposes gc and aggregate memory, and browser workers expose no collector-policy controls. Cross-engine policy/tuning instrumentation would maintain a private stress facility rather than public behavior. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [web/src/engine-host.js:462](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/web/src/engine-host.js#L462); [crates/bunwasm-runtime/src/js/bun.js:511](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L511) |
| `js/bun/resolve/load-same-js-file-a-lot.test.ts` | e → e | `TypeError: not a function`. Collector aggressiveness is JSC-private policy. Engine exposes gc and aggregate memory, and browser workers expose no collector-policy controls. Cross-engine policy/tuning instrumentation would maintain a private stress facility rather than public behavior. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [web/src/engine-host.js:462](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/web/src/engine-host.js#L462); [crates/bunwasm-runtime/src/js/bun.js:511](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L511) |
| `js/node/v8/v8-date-parser.test.js` | e → e | `TypeError: not a function`. Collector aggressiveness is JSC-private policy. Engine exposes gc and aggregate memory, and browser workers expose no collector-policy controls. Cross-engine policy/tuning instrumentation would maintain a private stress facility rather than public behavior. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [web/src/engine-host.js:462](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/web/src/engine-host.js#L462); [crates/bunwasm-runtime/src/js/bun.js:511](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L511) |
| `js/bun/css/angle-serialization-hang.test.ts` | e → c | `error: expect(received).toBe(expected)`. The angle fixture cannot destructure minifyTest from undefined cssInternals. The nesting fixture catches the same missing helper and prints its TypeError instead of a nesting-limit diagnostic. Bun's CSS parser is already portable Rust in this project. No OS limitation or exclusion cost is established for exposing the test adapter. | `test/js/bun/css/angle-serialization-hang.test.ts:37 @cd95fa7a`; [crates/bunwasm-runtime/src/js/builtins.js:856](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L856) |
| `js/bun/css/atan2-backtracking-hang.test.ts` | e → d | `error: expect(received).toBe(expected)`. The child calls public Bun.color and throws not a function. It never reaches color parsing or the nested atan2 complexity check. The Rust color/CSS implementation is portable; this is an API implementation gap, not a private-hook exclusion. | `test/js/bun/css/atan2-backtracking-hang.test.ts:36 @cd95fa7a`; [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449) |
| `js/bun/css/nested-selector-expansion.test.ts` | e → c | `error: expect(received).toContain(expected)`. The angle fixture cannot destructure minifyTest from undefined cssInternals. The nesting fixture catches the same missing helper and prints its TypeError instead of a nesting-limit diagnostic. Bun's CSS parser is already portable Rust in this project. No OS limitation or exclusion cost is established for exposing the test adapter. | `test/js/bun/css/nested-selector-expansion.test.ts:47 @cd95fa7a`; [crates/bunwasm-runtime/src/js/builtins.js:856](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L856) |
| `js/bun/test/expect-stack-overflow-crash.test.ts` | e → c | `error: expect(received).toBe(expected)`. The child reports the expected RangeError class, but its message lacks the final period in Bun's expected text. The record demonstrates a bounded public diagnostic mismatch. No host limitation or cost reason for excluding this assertion is established. | `test/js/bun/test/expect-stack-overflow-crash.test.ts:55 @cd95fa7a`; [crates/bunwasm-runtime/src/engine_quickjs.rs:243](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L243) |
| `regression/issue/30963.test.ts` | e → d | `error: expect(received).toContain(expected)`. The child rejects the malformed source with QuickJS Unexpected token instead of the expected Bun parser message. The eval entry is registered as source directly. No host capability prevents using the already compiled Bun parser, so this is eval parsing and diagnostic integration work. | `test/regression/issue/30963.test.ts:47 @cd95fa7a`; [crates/bunwasm-runtime/src/modules.rs:414](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L414) |
| `regression/issue/jsx-template-string-crash.test.ts` | e → d | `error: expect(received).toMatchInlineSnapshot(expected)`. Eval does not provide Bun's JSX parsing path. The valid React/TSX fixture emits no expected output, while the malformed JSX fixture receives QuickJS's unexpected less-than-token message instead of Bun's JSX lexer diagnostics. This needs eval loader and transpilation work; the invalid JSX record alone does not establish an unavoidable engine-wording exclusion. | `test/regression/issue/jsx-template-string-crash.test.ts:18 @cd95fa7a`; [crates/bunwasm-runtime/src/modules.rs:414](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L414) |
| `cli/heap-prof.test.ts` | e → e | `error: expect(received).toBe(expected)`. The first blocker is the rejected flag. Full truthful support needs allocation/CPU sampling hooks and native profile writers per engine, absent from Engine and standard browser-worker APIs. A flag stub cannot produce the requested profile artifacts. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-cli/src/main.rs:416](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L416) |
| `regression/issue/29240.test.ts` | e → e | `error: expect(received).toBe(expected)`. The first blocker is the rejected flag. Full truthful support needs allocation/CPU sampling hooks and native profile writers per engine, absent from Engine and standard browser-worker APIs. A flag stub cannot produce the requested profile artifacts. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-cli/src/main.rs:416](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L416) |
| `js/node/process/process-array-accessor-crash.test.ts` | a → c | `error: expect(received).toThrow(expected)`. The accessor test expects its getter error to propagate and receives not a function because setgroups is absent. Reading and validating an input array needs no host credential change. A valid setgroups operation may need a future host capability, but this first failure is argument validation. | `test/js/node/process/process-array-accessor-crash.test.ts:22 @cd95fa7a`; [crates/bunwasm-runtime/src/js/process.js:231](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L231) |
| `regression/issue/isArray-proxy-crash.test.ts` | a → c | `error: expect(received).toThrow()`. The process.setgroups Proxy check passes. The first failing assertion is vm.compileFunction with Proxy params, which returns a function instead of throwing. Its implementation joins params without the expected validation and ignores contextExtensions. No group-management syscall is implicated. | `test/regression/issue/isArray-proxy-crash.test.ts:57 @cd95fa7a`; [crates/bunwasm-runtime/src/js/builtins.js:322](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L322) |
| `js/bun/jsc/temporal-global.test.ts` | e → c | `error: expect(received).toEqual(expected)`. The child sees a Temporal object instead of undefined. The portable shim is lazily installed whenever the global is absent and does not check the opt-out environment flag. Honoring that installation choice does not require changing native JSC internals. | `test/js/bun/jsc/temporal-global.test.ts:20 @cd95fa7a`; [crates/bunwasm-runtime/src/js/bootstrap.js:799](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L799) |
| `js/node/process/process-memory-pressure.test.ts` | e → c | `error: expect(received).toEqual(expected)`. The fixture explicitly injects warning and critical through a missing test helper and observes no process events. Synthetic injection can validate and emit those events without causing real OS memory pressure. No native capability or high-cost instrumentation requirement is established by this test. | [crates/bunwasm-runtime/src/js/builtins.js:856](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L856); `test/js/node/process/process-memory-pressure.test.ts:1 @cd95fa7a` |
| `js/bun/module-graph/module-graph-gc.test.ts` | e → e | `SyntaxError: Could not find export 'generateHeapSnapshotForDebugging' in module 'bun:jsc'`. The private expected graph requires per-collector cells, edges and roots with Bun/JSC metadata. Engine and standard browser workers expose no heap graph; reproducing this private format needs separate collector instrumentation for each engine. | [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335); [crates/bunwasm-runtime/src/js/builtins.js:813](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L813) |
| `js/node/buffer-jit.test.ts` | e → e | `error: expect(received).toBe(expected)`. QuickJS interprets, JSC in wasm does not JIT, and unprivileged browser workers expose no no-inline or DFG compile-count control. Emulating JSC tiering state would fabricate the subject instead of measuring it. | [crates/bunwasm-runtime/src/engine_quickjs.rs:138](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L138); [jsc/README.md:25](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/jsc/README.md#L25); [crates/bunwasm-runtime/src/engine.rs:335](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine.rs#L335) |
| `js/bun/spawn/spawn-pipe-stale-fd-unregister.test.ts` | a → a | `error: expect(received).toEqual(expected)`. Raw ENOENT occurs at /proc/self/fd. The runner preopens only suite/tmp, and WASI guest descriptor numbers are not the launcher native fd table. No native descriptor-table/fcntl/poll introspection bridge exists. | [scripts/bun-suite.py:175](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/scripts/bun-suite.py#L175); [docs/host-abi.md:224](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L224) |
| `js/node/buffer-concat.test.ts` | e → e | `error: expect(received).toThrow(expected)`. The request exceeds the wasm32 buffer/address range and correctly throws RangeError. JSC-specific typed-array wording would falsely attribute that wasm32 guard to JSC, adding a diagnostic special case without changing behavior. | [crates/bunwasm-runtime/src/js/buffer.js:7](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/buffer.js#L7); [crates/bunwasm-runtime/src/js/buffer.js:524](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/buffer.js#L524) |
| `cli/run/commonjs-invalid.test.ts` | e → c | `error: expect(received).toContain(expected)`. The fixture is ordinary text headed @bun @bun-cjs, without the required function wrapper. It executes as CommonJS instead of producing the wrapper diagnostic. This check needs text-format validation, not native machine-code or bytecode execution, so it is a bounded loader gap. | `test/cli/run/cjs-fixture-bad.cjs:1 @cd95fa7a`; [crates/bunwasm-runtime/src/modules.rs:30](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L30) |
| `js/node/os/os.test.js` | a → a | `error: expect(received).toBe(expected)`. The artifact is wasm32-wasip1, while the upstream allowlist contains only native CPU architectures. Returning a native launcher CPU would misreport the guest address model. | [crates/bunwasm-runtime/src/js/builtins.js:43](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L43); [crates/bunwasm-runtime/src/js/process.js:181](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L181) |
| `js/node/process/process-execve.test.ts` | a → a | `error: expect(received).toBe(expected)`. The full operation replaces the calling OS process image while preserving identity/fds. WASI preview1 has no execve; child guests are stores on launcher threads, and spawn only starts a fresh copy of Bun. | [docs/host-abi.md:206](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L206); [docs/host-abi.md:239](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L239) |
| `regression/issue/29169.test.ts` | a → c | `error: expect(received).toBe(expected)`. The first assertion checks the property descriptor and receives no getter. Installing an accessor requires no OS parent-process lookup. A later test independently fails to open /proc/self/stat; that later platform dependency does not explain the first descriptor mismatch. | `test/regression/issue/29169.test.ts:35 @cd95fa7a`; [crates/bunwasm-runtime/src/js/process.js:197](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L197) |
| `regression/issue/29519.test.ts` | e → d | `error: expect(received).toBe(expected)`. The failing child constructs ShadowRealm and prints no ok marker. This is an absent realm API, not evidence that concurrent GC failed. A portable realm implementation would be substantial work, but the record supplies no platform impossibility or explicit reason to exclude it. | `test/regression/issue/29519.test.ts:69 @cd95fa7a`; [crates/bunwasm-runtime/src/engine_quickjs.rs:138](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L138) |
| `regression/issue/18239/18239.test.ts` | a → b | `error: expect(received).toContain(expected)`. The dispatcher accepts only the guest Bun executable. The delayed-pipe fixture invokes bash, and the isolated-event-loop case invokes echo. Both are rejected with ENOENT and empty child stdout before their intended checks. BEFORE and AFTER remain visible in the echo case, so parent stdout damage is not established. Other members invoke fake rustc/rustup, yes, chmod, or another native executable. | `test/regression/issue/18239/18239.test.ts:13 @cd95fa7a`; [crates/bunwasm-runtime/src/js/spawn.js:61](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L61) |
| `js/node/process/process-stdio-stack-overflow.test.ts` | e → c | `error: expect(received).toEqual(expected)`. All four raw failures expect signalCode undefined and receive null. The normal spawnSync return supplies null for an unsignalled child. Empty stderr satisfies expect.any(String), as matchesConstructor explicitly accepts primitive strings. This result-shape assertion establishes no stack-exhaustion or stdio initialization failure. | `test/js/node/process/process-stdio-stack-overflow.test.ts:16 @cd95fa7a`; [crates/bunwasm-runtime/src/js/spawn.js:321](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L321); [crates/bunwasm-runtime/src/js/bun_test.js:88](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L88) |
| `js/web/workers/worker-terminate-funnels.test.ts` | a → a | `error: expect(received).toEqual(expected)`. workerData contains a SharedArrayBuffer control block. The codec rejects it; independent guest stores and the worker wire protocol have no shared-JS-buffer backing-store identity/handle. | [crates/bunwasm-runtime/src/js/worker_codec.ts:66](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/worker_codec.ts#L66); [docs/host-abi.md:239](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/docs/host-abi.md#L239); `test/js/web/workers/worker-terminate-funnels-fixture.ts:744 @cd95fa7a` |
| `js/node/zlib/zlib-handle-bounds-check.test.ts` | e → d | `error: expect(received).toThrow(expected)`. The fixture calls _handle.writeSync before its bounds assertion, but that private object is absent. Compression itself already runs through portable Rust natives. Providing the handle contract and its buffer/lifetime rules is implementation work that can also support upstream Node/Bun zlib code. The raw record establishes no host impossibility or sufficient cost reason to exclude it. | [crates/bunwasm-runtime/src/js/builtins.js:607](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L607); `test/js/node/zlib/zlib-handle-bounds-check.test.ts:16 @cd95fa7a` |
| `js/bun/spawn/spawnsync-isolated-event-loop.test.ts` | c → b | `error: expect(received).toContain(expected)`. The dispatcher accepts only the guest Bun executable. The delayed-pipe fixture invokes bash, and the isolated-event-loop case invokes echo. Both are rejected with ENOENT and empty child stdout before their intended checks. BEFORE and AFTER remain visible in the echo case, so parent stdout damage is not established. Other members invoke fake rustc/rustup, yes, chmod, or another native executable. | `test/js/bun/spawn/spawnsync-isolated-event-loop.test.ts:91 @cd95fa7a`; [crates/bunwasm-runtime/src/js/spawn.js:61](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L61) |

</details>



### Reproduce one cause

Build the three artifacts from this branch and install the pinned dependencies as described in [the suite README](guide.md#reproduce). The helper runs each file unchanged through the required suite queue, with the same loopback network policy and deadlines as the baseline. Every cause below has one invocation. Every member file can be substituted.

```bash
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-triage-target
bash /work/tmp/wave-heavy/run.sh --class build "triage launcher" -- \
  env PATH="$PATH" cargo build -j 6 --release -p bunwasm-host
export TRIAGE_RESULTS=/work/reports/bun-wasm-triage-reproductions
mkdir -p "$TRIAGE_RESULTS"
suite() {
  local engine="$1" file="$2"
  bash /work/tmp/wave-heavy/run.sh --class suite "triage $engine $file" -- \
    env PATH="$PATH" scripts/bun-suite.sh --engine "$engine" \
    --network loopback --jobs 1 --timeout 15 \
    --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
    --output "$TRIAGE_RESULTS/$engine-$(date +%s%N).json" "$file"
}
suite quickjs 'cli/install/GHSA-pfwx-36v6-832x.test.ts'
```

The runner owns its temporary snapshots and process groups. The person running this helper owns `TRIAGE_RESULTS` and the private build target. Retain the JSON for review, then remove those owned paths after the run. Repeat an engine-difference reproducer with `suite jsc` and `suite browser`; compare the named assertion as well as file exit status.

### Ranking by observed file count

The rank uses file count, then cause title. A high rank measures coverage in this selection, not implementation cost or product priority. The implementation references are investigation starting points. A missing export points to its registration site; a backend or ordering diagnosis remains a hypothesis until a focused trace establishes it.

| Rank | Concrete cause | Files | Category |
|---|---|---|---|
| 1 | [bun lint has no command implementation](#cause-linter) | 22 | d |
| 2 | [External registry access is blocked by the loopback-only census](#cause-loopback-external) | 19 | c |
| 3 | [Bun.Archive is absent](#cause-archive) | 15 | d |
| 4 | [Bun.Transpiler is absent](#cause-transpiler) | 14 | d |
| 5 | [Bun.version_with_sha is absent and breaks harness version normalization](#cause-snapshot-version) | 13 | c |
| 6 | [jest.useFakeTimers, useRealTimers and setSystemTime are absent](#cause-fake-timers) | 12 | d |
| 7 | [The global Web Worker constructor is absent](#cause-web-worker) | 11 | d |
| 8 | [bun fmt has no command implementation](#cause-formatter) | 10 | d |
| 9 | [Test report paths are relative to the working directory instead of the source root](#cause-runner-path) | 9 | c |
| 10 | [The installer rejects manifests with workspaces](#cause-install-workspaces) | 9 | d |
| 11 | [HTMLRewriter is absent](#cause-htmlrewriter) | 8 | d |
| 12 | [Bun.$ has no cwd, throws, nothrow or execution implementation](#cause-shell-config) | 7 | d |
| 13 | [process.stdin lacks pipe and live Node readable behavior](#cause-stdin-pipe) | 7 | d |
| 14 | [Subprocess dispatch only supports the wasm Bun executable](#cause-external-program) | 7 | b |
| 15 | [toThrow does not await a returned rejecting promise](#cause-async-tothrow) | 7 | c |
| 16 | [Zstd stream constructors and compression functions are absent](#cause-zlib-zstd) | 7 | d |
| 17 | [bun:jsc.estimateShallowMemoryUsageOf has no engine-independent implementation](#cause-shallow-memory) | 5 | e |
| 18 | [Bun.Terminal needs a PTY and termios host capability](#cause-terminal) | 5 | a |
| 19 | [node:crypto.X509Certificate is not exported](#cause-x509) | 5 | d |
| 20 | [Registry requests send the wrong npm Accept header](#cause-manifest-accept) | 5 | c |
| 21 | [UDP and resolver datagram sockets have no host ABI](#cause-udp) | 5 | a |
| 22 | [Brotli compression and decompression are stubbed](#cause-zlib-brotli) | 4 | d |
| 23 | [bun run treats following runtime options as a filename](#cause-post-run-flags) | 4 | c |
| 24 | [bun update is absent](#cause-update-command) | 4 | d |
| 25 | [bun:wrap has no __decorateElement export](#cause-decorator-helper) | 4 | c |
| 26 | [Bun.cron and Bun.cron.parse are absent](#cause-cron) | 4 | d |
| 27 | [Bun.markdown is absent](#cause-markdown) | 4 | d |
| 28 | [Bun.WebView constructor and CDP client are absent](#cause-webview) | 4 | d |
| 29 | [expect.toBeWithin is absent](#cause-within) | 4 | c |
| 30 | [Resolver errors say package instead of module and omit structured diagnostics](#cause-resolve-wording) | 4 | c |
| 31 | [S3Client and Bun.s3 are absent](#cause-s3-api) | 4 | d |
| 32 | [The installer ignores existing npm, pnpm and Yarn lockfile migration](#cause-lock-migration) | 4 | d |
| 33 | [AbortController, EventTarget and CustomEvent lack their web toStringTag](#cause-web-brand) | 3 | c |
| 34 | [assert.partialDeepStrictEqual is absent](#cause-partial-assert) | 3 | c |
| 35 | [Body and Node stream consumers release locks that Bun retains](#cause-stream-lock) | 3 | d |
| 36 | [bun x and bunx execution are absent](#cause-x-command) | 3 | d |
| 37 | [Bun.Image codec and resize API is absent](#cause-archive-api-image) | 3 | d |
| 38 | [Bun.ModuleGraph is absent](#cause-module-graph) | 3 | d |
| 39 | [Bun.unsafe.gcAggressionLevel is native GC test control](#cause-unsafe-gc) | 3 | e |
| 40 | [bunfig preloads and preload-defined extensions are not applied](#cause-preload) | 3 | d |
| 41 | [Child IPC and process.send are unsupported](#cause-child-ipc) | 3 | b |
| 42 | [Conditional and each test builders lose their modifier methods](#cause-conditional-tests) | 3 | c |
| 43 | [Filesystem wrappers lose Node error code and path fields](#cause-fs-error-fields) | 3 | c |
| 44 | [HTTP and WebSocket serializers lowercase caller-visible header names](#cause-http-header-case) | 3 | c |
| 45 | [Installer lacks --lockfile-only mode](#cause-install-lockfile-only) | 3 | c |
| 46 | [Installer resolution does not handle local file dependency graphs](#cause-file-dependencies) | 3 | d |
| 47 | [Native FFI libraries and addon loading are unavailable](#cause-ffi) | 3 | a |
| 48 | [Package resolution requires dist.integrity or dist.shasum](#cause-install-integrity) | 3 | c |
| 49 | [process.stdout end, drain and async iteration contracts are incomplete](#cause-stdout-lifecycle) | 3 | d |
| 50 | [Runtime resolution does not auto-install package specifiers](#cause-autoinstall) | 3 | d |
| 51 | [The installer rejects --linker=hoisted while accepting the spaced form](#cause-install-equals-linker) | 3 | c |
| 52 | [BuildError diagnostics do not expose line and column positions](#cause-source-map-diagnostic) | 2 | d |
| 53 | [bun info and why are absent](#cause-info-why-command) | 2 | d |
| 54 | [bun patch and prune commands are absent](#cause-patch-command) | 2 | d |
| 55 | [bun pm migrate is absent](#cause-pm-migrate) | 2 | d |
| 56 | [bun:internal-for-testing.cssInternals.minifyTest is absent](#cause-css-test-hook) | 2 | c |
| 57 | [bun:test.onTestFinished is absent](#cause-runner-onfinished) | 2 | c |
| 58 | [Bun.sliceAnsi is absent](#cause-slice-ansi) | 2 | c |
| 59 | [Bun.wrapAnsi is absent](#cause-wrap-ansi) | 2 | c |
| 60 | [CI detection does not reject test.only](#cause-ci-only) | 2 | c |
| 61 | [CommonJS namespace interop exposes the wrong default and __esModule shape](#cause-cjs-interop) | 2 | d |
| 62 | [domainToASCII and domainToUnicode accept invalid domain input](#cause-url-idna) | 2 | c |
| 63 | [Dynamic data URL modules are resolved as package names](#cause-eval-data-url) | 2 | d |
| 64 | [Error frames and diff printing diverge from Bun's assertion report](#cause-runner-format) | 2 | c |
| 65 | [Error stacks are not remapped through the expected source maps](#cause-stack-map) | 2 | d |
| 66 | [Eval mode does not provide native Bun's TSX and React evaluation behavior](#cause-eval-jsx) | 2 | d |
| 67 | [expect.extend silently accepts non-callable entries](#cause-extend-validation) | 2 | c |
| 68 | [expect.pass and expect.fail are absent](#cause-pass-fail-matchers) | 2 | c |
| 69 | [Installer does not honor scoped npmrc registry URL paths](#cause-install-registry-config) | 2 | c |
| 70 | [Installer does not parse --cpu, --os or --libc overrides](#cause-install-platform) | 2 | c |
| 71 | [Installer rejects --backend and --backend=hardlink](#cause-install-backend) | 2 | c |
| 72 | [Matcher failures omit the custom expectation label](#cause-expect-label) | 2 | c |
| 73 | [Native CPU and heap profiler CLI output is unavailable](#cause-profiler-flags) | 2 | e |
| 74 | [Native fetch does not recover a closed pooled connection](#cause-f-fetch-retry) | 2 | f |
| 75 | [Native fetch ignores explicit proxy selection](#cause-fetch-proxy) | 2 | d |
| 76 | [QuickJS is built without Atomics](#cause-f-atomics) | 2 | f |
| 77 | [QuickJS parser and builtin messages differ from JSC](#cause-f-parser-wording) | 2 | f |
| 78 | [Request body normalization stringifies FormData instead of encoding multipart data](#cause-formdata-body) | 2 | d |
| 79 | [Runtime TypeScript loading does not emit the requested legacy decorator behavior](#cause-decorators) | 2 | d |
| 80 | [Standalone compilation and native bytecode tooling are absent](#cause-compiled-bytecode) | 2 | d |
| 81 | [Startup does not load the requested dotenv files](#cause-dotenv) | 2 | d |
| 82 | [Subprocess.resourceUsage returns undefined](#cause-subprocess-resource) | 2 | c |
| 83 | [The installer only implements the hoisted linker](#cause-install-isolated) | 2 | d |
| 84 | [The test runner ignores retry and rerun-each flags](#cause-retry-rerun) | 2 | d |
| 85 | [vm.SourceTextModule is absent](#cause-vm-module) | 2 | d |
| 86 | [--minimum-release-age is rejected by the install parser](#cause-install-release-age) | 1 | c |
| 87 | [--no-addons is rejected before the worker can report ERR_DLOPEN_DISABLED](#cause-no-addons-flag) | 1 | c |
| 88 | [--pass-with-no-tests does not change the empty-suite exit code](#cause-no-tests) | 1 | c |
| 89 | [--yarn lockfile output and workspace protocol serialization are absent](#cause-yarn-workspace) | 1 | d |
| 90 | [A renamed current directory is not preserved as a usable child cwd](#cause-spawn-renamed-cwd) | 1 | c |
| 91 | [AbortSignal.any does not reject a non-AbortSignal iterator result](#cause-abort-any-validation) | 1 | c |
| 92 | [Adding explicit packages reports install instead of add](#cause-install-add-header) | 1 | c |
| 93 | [afterAll hooks are skipped after a failing beforeAll](#cause-runner-failure-hooks) | 1 | c |
| 94 | [Already-aborted spawn forwards signal.reason without Node's ABORT_ERR fields](#cause-spawn-abort-code) | 1 | c |
| 95 | [An empty imported text file returns an object instead of a string](#cause-empty-text-loader) | 1 | c |
| 96 | [An empty install writes a lockfile instead of deleting it](#cause-install-empty-lock) | 1 | c |
| 97 | [Async macro expansion emits a pending Promise instead of its resolved value](#cause-macro-promise) | 1 | d |
| 98 | [AsyncLocalStorage ignores its defaultValue option](#cause-als-default) | 1 | c |
| 99 | [Buffer.from creates a fixed-length view over a resizable ArrayBuffer](#cause-buffer-resize) | 1 | c |
| 100 | [bun check is absent](#cause-check-command) | 1 | d |
| 101 | [bun create is absent](#cause-create-init-command) | 1 | d |
| 102 | [bun init is absent](#cause-init-command) | 1 | d |
| 103 | [bun link is absent](#cause-link-command) | 1 | d |
| 104 | [bun pm fetch is absent](#cause-pm-fetch) | 1 | d |
| 105 | [bun pm ls fails on an unresolved optional peer entry](#cause-pm-optional-peer) | 1 | c |
| 106 | [bun pm pkg is absent](#cause-pm-pkg) | 1 | d |
| 107 | [bun pm version is absent](#cause-pm-version) | 1 | d |
| 108 | [bun publish help is absent](#cause-publish-command) | 1 | d |
| 109 | [bun repl is absent](#cause-repl-command) | 1 | d |
| 110 | [bun run does not resolve package.json script names](#cause-package-run-script) | 1 | d |
| 111 | [bun run opens a directory instead of resolving its package entry](#cause-entry-directory) | 1 | c |
| 112 | [BUN_CONFIG_VERBOSE_FETCH=curl produces no request trace](#cause-fetch-verbose) | 1 | c |
| 113 | [BUN_OPTIONS is not parsed before CLI dispatch](#cause-bun-options) | 1 | c |
| 114 | [bun:internal-for-testing.emitMemoryPressure is absent](#cause-emit-memory-pressure) | 1 | c |
| 115 | [bun:jsc.generateHeapSnapshotForDebugging is absent](#cause-native-heap-snapshot) | 1 | e |
| 116 | [bun:jsc.noInline is absent](#cause-noinline) | 1 | e |
| 117 | [bun:main is not a registered builtin module](#cause-bun-main) | 1 | d |
| 118 | [bun:test lacks xit, xtest and xdescribe aliases](#cause-skip-aliases) | 1 | c |
| 119 | [Bun.build called from a macro does not reach the expected rejection handler](#cause-macro-build) | 1 | d |
| 120 | [Bun.color is absent](#cause-public-color) | 1 | d |
| 121 | [Bun.deepEquals accepts one argument instead of rejecting it](#cause-deep-equals-arity) | 1 | c |
| 122 | [Bun.deepEquals drops its fourth ignore-class-name argument](#cause-deep-equals-fourth) | 1 | c |
| 123 | [Bun.deepMatch passes the wrong partial-match semantics](#cause-deep-match) | 1 | c |
| 124 | [Bun.escapeHTML accepts Symbol instead of throwing](#cause-escape-html-symbol) | 1 | c |
| 125 | [Bun.escapeRegExp is absent](#cause-escape-regexp) | 1 | c |
| 126 | [Bun.file appends charset to an explicitly supplied MIME type](#cause-file-mime) | 1 | c |
| 127 | [Bun.file rejection stacks omit async frame markers](#cause-async-stack-wording) | 1 | c |
| 128 | [Bun.file.exists reports directories as existing files](#cause-bun-file-exists-dir) | 1 | c |
| 129 | [Bun.highlighter is absent](#cause-highlighter) | 1 | c |
| 130 | [Bun.inspect leaks internal BuildError formatting properties](#cause-inspect-build-error) | 1 | c |
| 131 | [Bun.openInEditor cannot launch an external editor](#cause-open-editor) | 1 | b |
| 132 | [Bun.plugin and its runtime build.module registry are absent](#cause-plugin-loader) | 1 | d |
| 133 | [Bun.randomUUIDv5 is absent](#cause-uuid5) | 1 | c |
| 134 | [Bun.secrets is absent, so argument errors have no Bun code](#cause-secrets-validation) | 1 | c |
| 135 | [Bun.spawn NUL validation uses a different public message](#cause-null-argument-wording) | 1 | c |
| 136 | [Bun.stdin.slice applies an offset that Bun ignores for stream stdin](#cause-file-stdin-slice) | 1 | c |
| 137 | [Bun.stripANSI does not consume a complete OSC title sequence](#cause-strip-ansi) | 1 | c |
| 138 | [Bun.write drops the requested filesystem mode](#cause-bun-write-mode) | 1 | c |
| 139 | [bunfig runtime option types are not validated](#cause-bunfig-validation) | 1 | c |
| 140 | [ChildProcess instances have no spawn method](#cause-child-instance-spawn) | 1 | c |
| 141 | [ClientRequest.setHeaders is absent](#cause-http-setheaders) | 1 | c |
| 142 | [CommonJS loading ignores user overrides of Module._extensions](#cause-require-extensions) | 1 | c |
| 143 | [console has no async line iterator](#cause-console-iterator) | 1 | d |
| 144 | [console.timeEnd writes to stdout instead of Bun's stderr](#cause-console-time-stream) | 1 | c |
| 145 | [crypto.createHash does not support SHAKE256 outputLength](#cause-shake256) | 1 | c |
| 146 | [crypto.createPublicKey rejects certificate PEMs](#cause-jwt-key-classification) | 1 | c |
| 147 | [CSS module imports return source text instead of an empty object](#cause-css-default) | 1 | c |
| 148 | [diagnostics_channel.channel accepts null names](#cause-diagnostic-channel) | 1 | c |
| 149 | [DOMException does not accept Bun's name-and-cause options object](#cause-domexception-name) | 1 | c |
| 150 | [Dots and only-failures reporters are not implemented](#cause-runner-reporters) | 1 | d |
| 151 | [Dynamic import in a top-level-await cycle exits before its continuation](#cause-tla-cycle) | 1 | d |
| 152 | [Embedded crypto key generation rejects P-521](#cause-f-p521) | 1 | f |
| 153 | [Embedded Web Streams expose minified constructor names](#cause-f-stream-class-name) | 1 | f |
| 154 | [Embedded WebCrypto rejects a valid noncanonical JWK oct encoding](#cause-f-jwk-octets) | 1 | f |
| 155 | [Embedded WebCrypto rejects X25519 deriveBits lengths that are not byte-aligned](#cause-f-x25519-bits) | 1 | f |
| 156 | [Embedded-engine require of ESM pumps user microtasks too early](#cause-f-require-microtasks) | 1 | f |
| 157 | [Error.prepareStackTrace has no default callable implementation](#cause-prepare-stack) | 1 | c |
| 158 | [Error.stackTraceLimit does not expose Bun's default property descriptor](#cause-stacktrace-limit) | 1 | c |
| 159 | [Eval skips Bun's dead-branch destructuring-var lowering](#cause-raw-js-parser) | 1 | d |
| 160 | [Eval uses engine syntax diagnostics instead of Bun parser diagnostics](#cause-eval-parser-diagnostic) | 1 | d |
| 161 | [EventEmitter.once is a normal function instead of an AsyncFunction](#cause-event-once-constructor) | 1 | c |
| 162 | [expect.toBeArrayOfSize is absent](#cause-array-size) | 1 | c |
| 163 | [expect.unreachable stringifies Error instead of preserving its message](#cause-unreachable-message) | 1 | c |
| 164 | [Fetch exposes the host backend's ConnectionRefused code](#cause-fetch-refused-code) | 1 | c |
| 165 | [Filesystem timestamps do not preserve the requested utimes values](#cause-mtime-write) | 1 | c |
| 166 | [fs.constants lacks UV_DIRENT_UNKNOWN and UV_DIRENT_FIFO](#cause-dirent-unknown) | 1 | c |
| 167 | [fs.mkdir callback adapter defers invalid path errors](#cause-mkdir-validation) | 1 | c |
| 168 | [fs.ReadStream has no close method](#cause-fs-readstream-close) | 1 | c |
| 169 | [Guest /proc/self/fd is not the native process descriptor table](#cause-procfs-descriptors) | 1 | a |
| 170 | [Immediate handles do not coerce to increasing numeric identifiers](#cause-immediate-id) | 1 | c |
| 171 | [Install progress output omits resolving and migration status](#cause-install-patch-progress) | 1 | c |
| 172 | [Installer does not execute package lifecycle scripts](#cause-install-lifecycle) | 1 | d |
| 173 | [Installer does not parse --filter workspace selection](#cause-install-filter) | 1 | c |
| 174 | [Installer ignores packageExtensions metadata](#cause-package-extensions) | 1 | d |
| 175 | [Installer rejects --destination before workspace migration](#cause-install-destination) | 1 | c |
| 176 | [Installer rejects an unresolved optional dependency with an empty name](#cause-install-optional-empty) | 1 | c |
| 177 | [Large Buffer allocation uses the wasm limit rather than JSC's wording](#cause-large-buffer-wording) | 1 | e |
| 178 | [Legacy url.parse retains IPv6 brackets in hostname](#cause-url-legacy-ipv6) | 1 | c |
| 179 | [Legacy url.parse swallows primitive exceptions during argument description](#cause-legacy-url-coercion) | 1 | c |
| 180 | [Malformed @bun-cjs text wrappers are not rejected](#cause-compiled-cjs-marker) | 1 | c |
| 181 | [Matcher formatting omits FormData's non-callable toJSON property](#cause-formdata-inspect) | 1 | c |
| 182 | [MessageEvent.initMessageEvent is absent](#cause-messageevent-init) | 1 | c |
| 183 | [mkdir recursive accepts an existing file as a directory](#cause-mkdir-existing) | 1 | c |
| 184 | [Native error translation loses stable Node error codes](#cause-error-code-mirror) | 1 | c |
| 185 | [Native fetch omits its default Connection header](#cause-f-fetch-keepalive) | 1 | f |
| 186 | [Node error toString omits the bracketed error code](#cause-node-error-tostring) | 1 | c |
| 187 | [Node Worker lacks Symbol.asyncDispose](#cause-worker-dispose) | 1 | c |
| 188 | [node:dns lacks getDefaultResultOrder](#cause-dns-order) | 1 | c |
| 189 | [node:module.SourceMap is an empty class](#cause-module-source-map) | 1 | c |
| 190 | [Non-TTY stdin reports false instead of undefined](#cause-process-tty) | 1 | c |
| 191 | [os.arch truthfully reports wasm32 rather than a native CPU](#cause-os-arch) | 1 | a |
| 192 | [Package packing setup rejects --quiet](#cause-install-quiet) | 1 | c |
| 193 | [Path helpers reject boxed String values used by the fixture](#cause-boxed-paths) | 1 | c |
| 194 | [path.win32.dirname delegates to POSIX behavior](#cause-path-win32) | 1 | c |
| 195 | [performance.clearResourceTimings is absent](#cause-performance-resource) | 1 | c |
| 196 | [performance.toJSON returns only timeOrigin](#cause-performance-json) | 1 | c |
| 197 | [process.argv omits the leading --bun argument expected by parseArgs](#cause-argv-bun-flag) | 1 | c |
| 198 | [process.dlopen rejection omits ERR_DLOPEN_FAILED](#cause-dlopen-rejection-code) | 1 | c |
| 199 | [process.execve has no host process-replacement capability](#cause-process-execve) | 1 | a |
| 200 | [process.nextTick drains before the engine finishes the current microtask queue](#cause-nexttick-order) | 1 | d |
| 201 | [process.ppid is a data property instead of an accessor](#cause-process-ppid) | 1 | c |
| 202 | [process.setgroups input validation is absent](#cause-setgroups) | 1 | c |
| 203 | [process.stdin exposes ref for file input where Bun leaves it undefined](#cause-stdin-ref-type) | 1 | c |
| 204 | [process.title is fixed to bun instead of the executable path](#cause-process-title) | 1 | c |
| 205 | [QuickJS Intl shim has no DurationFormat](#cause-f-duration) | 1 | f |
| 206 | [QuickJS loses AsyncLocalStorage context across custom thenable assimilation](#cause-f-als-thenable) | 1 | f |
| 207 | [QuickJS Promise.try wraps a returned promise instead of preserving identity](#cause-f-promise-try) | 1 | f |
| 208 | [QuickJS receives import defer syntax without a lowering pass](#cause-import-defer) | 1 | d |
| 209 | [QuickJS says disposable where the fixture searches for dispose](#cause-f-disposal-wording) | 1 | f |
| 210 | [QuickJS source loading truncates or rejects NUL in template literals](#cause-f-nul-source) | 1 | f |
| 211 | [readableStreamToArrayBuffer calls a patched Promise.prototype.then](#cause-public-promise-then) | 1 | c |
| 212 | [readdir recursive skips symlink error traversal](#cause-fs-recursive-links) | 1 | c |
| 213 | [RedisClient and Bun.redis are absent](#cause-redis) | 1 | d |
| 214 | [reportError output and stack columns differ from Bun's public formatter](#cause-report-error) | 1 | c |
| 215 | [Request.cache is absent](#cause-request-cache) | 1 | c |
| 216 | [Request.formData receiver validation omits ERR_INVALID_THIS](#cause-invalid-this) | 1 | c |
| 217 | [require does not deliver the expected transitive-TLA TypeError](#cause-require-async-module) | 1 | d |
| 218 | [require leaves CommonJS module.children empty](#cause-module-children) | 1 | c |
| 219 | [Response.json accepts values JSON.stringify cannot serialize](#cause-response-json-validation) | 1 | c |
| 220 | [Runtime resolution ignores inherited tsconfig path mappings](#cause-tsconfig-paths) | 1 | d |
| 221 | [ShadowRealm constructor is absent](#cause-shadowrealm) | 1 | d |
| 222 | [Stack mapping does not report invalid source-map VLQ column values](#cause-negative-vlq) | 1 | c |
| 223 | [Stack-overflow message parity omits a trailing period](#cause-parser-native-wording) | 1 | c |
| 224 | [Static Bun.file routes ignore If-Modified-Since](#cause-static-conditional) | 1 | c |
| 225 | [Temporal installation ignores BUN_JSC_useTemporal=0](#cause-temporal-toggle) | 1 | c |
| 226 | [test.failing reports collection state before validating its callback](#cause-failing-validation) | 1 | c |
| 227 | [TextDecoder ASCII labels do not use Windows-1252 mappings](#cause-encoding-ascii) | 1 | c |
| 228 | [The CLI accepts a CSS entry instead of rejecting an unsupported run target](#cause-css-entry-diagnostic) | 1 | c |
| 229 | [The CLI rejects --conditions before resolving conditional exports](#cause-custom-conditions) | 1 | c |
| 230 | [The CLI treats a .wasm program as JavaScript source](#cause-wasm-entry) | 1 | d |
| 231 | [The runner ignores shard arguments and validation](#cause-shard) | 1 | c |
| 232 | [The test runner ignores a preload flag passed in equals form](#cause-async-preload) | 1 | c |
| 233 | [The URL host parser serializes an opaque scheme origin as null](#cause-url-opaque-origin) | 1 | c |
| 234 | [Timeout objects have no _idleStart field](#cause-timer-idlestart) | 1 | c |
| 235 | [Timer functions lack util.promisify.custom hooks](#cause-timer-promisify) | 1 | c |
| 236 | [Top-level await in CJS dynamic-import fixtures is not lowered correctly](#cause-cjs-dynamic-import) | 1 | d |
| 237 | [Unknown node builtins use ERR_MODULE_NOT_FOUND instead of ERR_UNKNOWN_BUILTIN_MODULE](#cause-unknown-builtin-code) | 1 | c |
| 238 | [Unsettled worker top-level await exits 0 instead of 13](#cause-worker-tla-exit) | 1 | c |
| 239 | [Unsignalled Bun.spawnSync returns signalCode null instead of undefined](#cause-spawn-sync-signal-code) | 1 | c |
| 240 | [URL parsing collapses repeated leading file path slashes](#cause-url-file-slashes) | 1 | c |
| 241 | [URL.createObjectURL is absent](#cause-blob-url) | 1 | d |
| 242 | [URLSearchParams methods do not validate missing arguments](#cause-urlsearchparams-arity) | 1 | c |
| 243 | [URLSearchParams.toJSON is absent](#cause-urlsearchparams-json) | 1 | c |
| 244 | [util.inspect passes a different function identity to inspect.custom](#cause-custom-inspect) | 1 | c |
| 245 | [vm.compileFunction accepts Proxy parameter lists](#cause-vm-proxy-validation) | 1 | c |
| 246 | [WebSocket handshake rejection omits Mismatch client protocol close reason](#cause-ws-protocol-error) | 1 | c |
| 247 | [Worker data cannot share the fixture's SharedArrayBuffer](#cause-worker-terminate-clone) | 1 | a |
| 248 | [Worker transfer validation throws DOMException instead of TypeError](#cause-transfer-error) | 1 | c |
| 249 | [zlib transform streams have no flush method](#cause-zlib-flush) | 1 | d |
| 250 | [zlib._handle.writeSync is absent](#cause-zlib-native-handle) | 1 | d |

<a id="cause-linter"></a>

### 1. bun lint has no command implementation

22 files. Category `d`. The CLI rejects lint before loading config or invoking rules. Empty diagnostics and absent JSON are consequences of the missing command.

Test subject `bun/ > no-eager-dynamic-import`. Throwing frame `at <anonymous> (<input>:1:1)`.

Observed diagnostic:

```text
cli/lint/bun-rules.test.ts:
SyntaxError: Unexpected end of JSON input
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:404](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L404). Reproducer `suite quickjs 'cli/lint/bun-rules.test.ts'`.

<details>
<summary>All 22 member files</summary>

- `cli/lint/bun-rules.test.ts`
- `cli/lint/bunfig.test.ts`
- `cli/lint/config-files.test.ts`
- `cli/lint/doctor.test.ts`
- `cli/lint/explain.test.ts`
- `cli/lint/glob.test.ts`
- `cli/lint/help.test.ts`
- `cli/lint/hints.test.ts`
- `cli/lint/import-attributes.test.ts`
- `cli/lint/init.test.ts`
- `cli/lint/js-parsers.test.ts`
- `cli/lint/json-parse.test.ts`
- `cli/lint/messages.test.ts`
- `cli/lint/native-rules.test.ts`
- `cli/lint/output.test.ts`
- `cli/lint/oxc-errors.test.ts`
- `cli/lint/oxc-names.test.ts`
- `cli/lint/prettier-rule.test.ts`
- `cli/lint/rule-docs.test.ts`
- `cli/lint/rule-throws.test.ts`
- `cli/lint/rules.test.ts`
- `cli/lint/scanner.test.ts`

</details>

<a id="cause-loopback-external"></a>

### 2. External registry access is blocked by the loopback-only census

19 files. Category `c`. The isolated namespace has no external route. In the template typecheck fixture the first child performs an unmocked public-registry add before reaching tsc. Use a recorded local registry fixture to distinguish install behavior from this test-environment blocker; WASI networking itself works.

Test subject `bunx runs the bin of a directories.bin package`. Throwing frame `at <anonymous> (/bun/test/cli/install/bunx-directories-bin.test.ts:29:52)`.

Observed diagnostic:

```text
-   "exitCode": 0,
+   "exitCode": 1,
+   "stderr": "error: Network is unreachable (os error 101)
+ ",
```

Suspected implementation [crates/bunwasm-runtime/src/install/io.rs:29](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/io.rs#L29). Reproducer `suite quickjs 'cli/install/bunx-directories-bin.test.ts'`.

<details>
<summary>All 19 member files</summary>

- `cli/install/bunx-directories-bin.test.ts`
- `cli/install/config-version.test.ts`
- `cli/install/lockfile-version-2.test.ts`
- `integration/datadog-pprof/datadog-pprof.test.ts`
- `integration/esbuild/esbuild.test.ts`
- `integration/expo-app/expo.test.ts`
- `integration/vite-build/vite-build.test.ts`
- `js/node/process/dlopen-duplicate-load.test.ts`
- `js/third_party/next-auth/next-auth.test.ts`
- `regression/issue/00631.test.ts`
- `regression/issue/07740.test.ts`
- `regression/issue/11806.test.ts`
- `regression/issue/24364.test.ts`
- `regression/issue/26338.test.ts`
- `regression/issue/26657.test.ts`
- `regression/issue/28193.test.ts`
- `regression/issue/29371.test.ts`
- `regression/issue/30205.test.ts`
- `regression/issue/ctrl-c.test.ts`

</details>

<a id="cause-archive"></a>

### 3. Bun.Archive is absent

15 files. Category `d`. Constructing a gzip tarball throws before the registry fixture or archive assertions can run. This is the missing Archive constructor, not a package-manager assertion defect.

Test subject `<collection>`. Throwing frame `at githubTarball (/bun/test/harness.ts:2110:14)`.

Observed diagnostic:

```text
return new Bun.Archive(entries, { compress: "gzip" }).bytes();                     ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'cli/install/GHSA-pfwx-36v6-832x.test.ts'`.

<details>
<summary>All 15 member files</summary>

- `cli/install/GHSA-pfwx-36v6-832x.test.ts`
- `cli/install/bun-add.test.ts`
- `cli/install/bun-install-cache-publish.test.ts`
- `cli/install/bun-install-lifecycle-scripts.test.ts`
- `cli/install/bun-install-offline-misses.test.ts`
- `cli/install/bun-install-staging.test.ts`
- `cli/install/bun-install.test.ts`
- `cli/install/bun-update-lockfile-sync.test.ts`
- `cli/install/bunx.test.ts`
- `cli/install/escape-control-characters.test.ts`
- `cli/install/install-fd-leak.test.ts`
- `cli/run/run-autoinstall-abs-path.test.ts`
- `js/bun/archive.test.ts`
- `packages/registry/test/publish.test.ts`
- `packages/registry/test/read.test.ts`

</details>

<a id="cause-transpiler"></a>

### 4. Bun.Transpiler is absent

14 files. Category `d`. The public constructor is absent even though the Rust CLI transpiler exists. Constructor, scan and transform fixtures stop before testing parser behavior.

Test subject `using / await using is not lowered when targeting bun > single-use using declaration is not inlined away`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/lower-using-bun-target.test.ts:36:19)`.

Observed diagnostic:

```text
const t = new Bun.Transpiler({ target: "bun" });                        ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/resolve/lower-using-bun-target.test.ts'`.

<details>
<summary>All 14 member files</summary>

- `js/bun/resolve/lower-using-bun-target.test.ts`
- `js/bun/transpiler/repl-transform.test.ts`
- `js/bun/transpiler/transpiler-comma-chain-oom.test.ts`
- `js/bun/transpiler/transpiler-enum-concat-chain-oom.test.ts`
- `js/bun/transpiler/transpiler-error-gc-uaf.test.ts`
- `js/bun/transpiler/transpiler-radix-bigint.test.ts`
- `js/bun/transpiler/transpiler-tsconfig-uaf.test.ts`
- `js/bun/transpiler/transpiler-utf16-loader.test.ts`
- `regression/issue/012039.test.ts`
- `regression/issue/09748.test.ts`
- `regression/issue/13251.test.ts`
- `regression/issue/14477/14477.test.ts`
- `regression/issue/24709.test.ts`
- `regression/issue/27575.test.ts`

</details>

<a id="cause-snapshot-version"></a>

### 5. Bun.version_with_sha is absent and breaks harness version normalization

13 files. Category `c`. Bun.version_with_sha is undefined. The harness cannot replace the full version/revision header, so it leaves v<bun-version> and the real revision in the received snapshot. Match the missing public property before changing snapshots.

Test subject `syntax > npm object scopes the rule to the parent's edge`. Throwing frame `at installOk (/bun/test/cli/install/nested-overrides.test.ts:59:18)`.

Observed diagnostic:

```text
Expected: "bun install undefined"
Received: "bun install v1.4.4 (cd95fa7a1)"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:456](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L456). Reproducer `suite quickjs 'cli/install/nested-overrides.test.ts'`.

<details>
<summary>All 13 member files</summary>

- `cli/install/nested-overrides.test.ts`
- `cli/test/test-filter-lifecycle-snapshot.test.ts`
- `js/bun/test/concurrent_immediate.test.ts`
- `js/bun/test/test-error-code-done-callback.test.ts`
- `js/bun/test/test-test.test.ts`
- `regression/issue/14135.test.ts`
- `regression/issue/19758.test.ts`
- `regression/issue/20100.test.ts`
- `regression/issue/21177.test.ts`
- `regression/issue/21830.test.ts`
- `regression/issue/23865.test.ts`
- `regression/issue/5738.test.ts`
- `regression/issue/5961.test.ts`

</details>

<a id="cause-fake-timers"></a>

### 6. jest.useFakeTimers, useRealTimers and setSystemTime are absent

12 files. Category `d`. The Sinon adapter calls the missing timer-control method at setup-tests.ts:14. Real clock scheduling is not the cause of these failures.

Test subject `#187 - Support timeout.refresh in node environments > calls the stub again after refreshing the timeout`. Throwing frame `at install (/bun/test/js/bun/test/fake-timers/sinonjs/helpers/setup-tests.ts:14:8)`.

Observed diagnostic:

```text
vi.useFakeTimers({ now: opts.now });             ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:662](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L662). Reproducer `suite quickjs 'js/bun/test/fake-timers/sinonjs/issue-187.test.ts'`.

<details>
<summary>All 12 member files</summary>

- `js/bun/test/fake-timers/sinonjs/issue-187.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-207.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-315.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-368.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-437.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-504.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-67.test.ts`
- `js/bun/test/fake-timers/sinonjs/issue-73.test.ts`
- `js/bun/test/test-timers.test.ts`
- `regression/issue/25869.test.ts`
- `regression/issue/26284.test.ts`
- `regression/issue/32793.test.ts`

</details>

<a id="cause-web-worker"></a>

### 7. The global Web Worker constructor is absent

11 files. Category `d`. node:worker_threads support does not install the Web Worker global. Worker setup throws before postMessage or lifetime checks.

Test subject `Bun.isMainThread`. Throwing frame `at /bun/test/js/bun/util/main-worker-file.js:6:22`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:1297](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L1297). Reproducer `suite quickjs 'js/bun/util/bun-isMainThread.test.js'`.

<details>
<summary>All 11 member files</summary>

- `js/bun/util/bun-isMainThread.test.js`
- `js/third_party/comlink/comlink.test.ts`
- `js/web/broadcastchannel/broadcast-channel-worker-gc.test.ts`
- `js/web/broadcastchannel/broadcast-channel.test.ts`
- `js/web/structured-clone-shared-array-buffer.test.ts`
- `js/web/timers/timer-heap-race.test.ts`
- `js/web/workers/message-port-context-destroy-leak.test.ts`
- `js/web/workers/worker-entry-point.test.ts`
- `js/web/workers/worker-terminate-lifetime.test.ts`
- `js/web/workers/worker.test.ts`
- `js/web/workers/worker_blob.test.ts`

</details>

<a id="cause-formatter"></a>

### 8. bun fmt has no command implementation

10 files. Category `d`. Formatter fixtures receive an unsupported-command diagnostic, empty stdout, unchanged input and exit 1. The large assertion counts do not identify separate formatting algorithms to fix.

Test subject `sortImports > groups built-ins, packages, aliases, relative paths and styles, separated by blank lines`. Throwing frame `at <anonymous> (/bun/test/cli/format/bunfig.test.ts:75:27)`.

Observed diagnostic:

```text
- ""
+ "error: bun fmt is not supported in bun-wasm
+ "
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:404](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L404). Reproducer `suite quickjs 'cli/format/bunfig.test.ts'`.

<details>
<summary>All 10 member files</summary>

- `cli/format/bunfig.test.ts`
- `cli/format/format-doctor.test.ts`
- `cli/format/glob.test.ts`
- `cli/format/oxfmt-cli/oxfmt-cli.test.ts`
- `cli/format/prettier-cli/prettier-cli.test.ts`
- `cli/format/sort-imports.test.ts`
- `cli/format/sort-imports/sort-imports.test.ts`
- `cli/format/svelte/svelte.test.ts`
- `cli/format/tailwind/tailwind.test.ts`
- `cli/format/words.test.ts`

</details>

<a id="cause-runner-path"></a>

### 9. Test report paths are relative to the working directory instead of the source root

9 files. Category `c`. The snapshot expects a test/ prefix and receives a cwd-relative path. Only assign files where this is the first visible difference; later hook or error differences can remain.

Test subject `CLAUDECODE=1 shows quiet test output (only failures)`. Throwing frame `at <anonymous> (file:NN:NN)`.

Observed diagnostic:

```text
- bun test <version> (<revision>)"
+ bun test v<bun-version> (cd95fa7a1)"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2186](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2186). Reproducer `suite quickjs 'cli/test/claudecode-flag.test.ts'`.

<details>
<summary>All 9 member files</summary>

- `cli/test/claudecode-flag.test.ts`
- `js/bun/test/bun_test.test.ts`
- `js/bun/test/concurrent.test.ts`
- `js/bun/test/only-failures.test.ts`
- `regression/issue/11793.test.ts`
- `regression/issue/12782.test.ts`
- `regression/issue/19875.test.ts`
- `regression/issue/20092.test.ts`
- `regression/issue/20980.test.ts`

</details>

<a id="cause-install-workspaces"></a>

### 10. The installer rejects manifests with workspaces

9 files. Category `d`. execute rejects workspaces before resolution, scanner invocation or lockfile pruning. These downstream assertions share the same first blocker.

Test subject `link:<path> (hoisted) > is relative to the declaring package.json, in the root and in a workspace`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-install-link-path.test.ts:104:27)`.

Observed diagnostic:

```text
Expected to not contain: "error:"
Received: "error: Workspace installs are not supported in bun-wasm yet\n"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:84](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L84). Reproducer `suite quickjs 'cli/install/bun-install-link-path.test.ts'`.

<details>
<summary>All 9 member files</summary>

- `cli/install/bun-install-link-path.test.ts`
- `cli/install/bun-link.test.ts`
- `cli/install/bun-security-scanner-workspaces.test.ts`
- `cli/install/frozen-lockfile-member-pins.test.ts`
- `cli/install/frozen-lockfile-outdated.test.ts`
- `cli/install/frozen-lockfile-pruned.test.ts`
- `cli/install/frozen-lockfile-workspace-names.test.ts`
- `cli/install/test-dev-peer-dependency-priority.test.ts`
- `regression/issue/28170.test.ts`

</details>

<a id="cause-htmlrewriter"></a>

### 11. HTMLRewriter is absent

8 files. Category `d`. Handler validation and transform tests fail before the rewrite operation. The missing global must be implemented before analyzing selector or serialization behavior.

Test subject `HTMLRewriter DOCTYPE handler > remove and removed property work on DOCTYPE`. Throwing frame `at <anonymous> (/bun/test/js/web/html/html-rewriter-doctype.test.ts:9:26)`.

Observed diagnostic:

```text
const rewriter = new HTMLRewriter().onDocument({                              ^
ReferenceError: HTMLRewriter is not defined
```

Suspected implementation [crates/bunwasm-runtime/src/js/bootstrap.js:1](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L1). Reproducer `suite quickjs 'js/web/html/html-rewriter-doctype.test.ts'`.

<details>
<summary>All 8 member files</summary>

- `js/web/html/html-rewriter-doctype.test.ts`
- `js/workerd/html-rewriter-end-error.test.ts`
- `js/workerd/html-rewriter-leak.test.ts`
- `regression/issue/07827.test.ts`
- `regression/issue/19219.test.ts`
- `regression/issue/21680.test.ts`
- `regression/issue/htmlrewriter-additional-bugs.test.ts`
- `regression/issue/text-chunk-null-access.test.ts`

</details>

<a id="cause-shell-config"></a>

### 12. Bun.$ has no cwd, throws, nothrow or execution implementation

7 files. Category `d`. The exported shell value is an unsupported-operation function, not the configurable tagged-template shell. The specific missing member comes from the throwing source line.

Test subject `test.only shouldn't need --only for ./only-fixture-1.ts`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/test-only.test.ts:8:28)`.

Observed diagnostic:

```text
const result = await $.cwd(import.meta.dir)`${bunExe()} test ${file}`.env({ ...bunEnv, CI: "false" });                                ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:514](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L514). Reproducer `suite quickjs 'js/bun/test/test-only.test.ts'`.

<details>
<summary>All 7 member files</summary>

- `js/bun/test/test-only.test.ts`
- `js/bun/util/which.test.ts`
- `js/third_party/body-parser/express-bun-build-compile.test.ts`
- `regression/issue/09559.test.ts`
- `regression/issue/10132.test.ts`
- `regression/issue/25831.test.ts`
- `regression/issue/26460.test.ts`

</details>

<a id="cause-stdin-pipe"></a>

### 13. process.stdin lacks pipe and live Node readable behavior

7 files. Category `d`. The stdin adapter buffers input and lacks the Node stream pipe method. Readable-mode and pause/resume fixtures also observe empty input instead of their supplied text.

Test subject `Bun.spawn stdin from Blob falls back when memfd is disabled`. Throwing frame `at <anonymous> (/bun/test/js/bun/memfd-disabled.test.ts:42:36)`.

Observed diagnostic:

```text
- ""
+ "1 | process.stdin.pipe(process.stdout)
+                   ^
+ TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:125](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L125). Reproducer `suite quickjs 'js/bun/memfd-disabled.test.ts'`.

<details>
<summary>All 7 member files</summary>

- `js/bun/memfd-disabled.test.ts`
- `js/bun/spawn/spawn-empty-arrayBufferOrBlob.test.ts`
- `js/bun/spawn/spawn-stdin-readable-stream-edge-cases.test.ts`
- `js/bun/spawn/spawn-stdin-readable-stream-integration.test.ts`
- `js/node/child_process/child-process-stdio.test.js`
- `js/node/readline/pause_stdin_should_exit.test.ts`
- `regression/issue/11297/11297.test.ts`

</details>

<a id="cause-external-program"></a>

### 14. Subprocess dispatch only supports the wasm Bun executable

7 files. Category `b`. The dispatcher accepts only the guest Bun executable. The delayed-pipe fixture invokes bash, and the isolated-event-loop case invokes echo. Both are rejected with ENOENT and empty child stdout before their intended checks. BEFORE and AFTER remain visible in the echo case, so parent stdout damage is not established. Other members invoke fake rustc/rustup, yes, chmod, or another native executable.

Test subject `the configure-time rustc probe pins the rustup proxy to the pinned channel`. Throwing frame `at <anonymous> (/bun/test/internal/build-rust-toolchain-probe.test.ts:48:39)`.

Observed diagnostic:

```text
-   "rustHostTriple": "host-for-nightly-2026-09-15",
-   "rustLlvmVersion": "23.1.1",
-   "rustSysroot": "/tmp/build-rustc-probe_JZuxhd/sysroot-for-nightly-2026-09-15",
+   "rustHostTriple": undefined,
+   "rustLlvmVersion": undefined,
+   "rustSysroot": undefined,
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:62](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L62). Reproducer `suite quickjs 'internal/build-rust-toolchain-probe.test.ts'`.

<details>
<summary>All 7 member files</summary>

- `internal/build-rust-toolchain-probe.test.ts`
- `internal/rust-check-all.test.ts`
- `js/bun/spawn/spawn-maxbuf.test.ts`
- `js/bun/spawn/spawnsync-isolated-event-loop.test.ts`
- `regression/issue/18239/18239.test.ts`
- `regression/issue/20753.test.js`
- `regression/issue/24329.test.ts`

</details>

<a id="cause-async-tothrow"></a>

### 15. toThrow does not await a returned rejecting promise

7 files. Category `c`. throwOutcome records a returned Promise as a successful return. Bun's fixtures expect async callback rejection to satisfy toThrow. Fix the matcher before assigning these cases to filesystem, JSON, encoding or fetch.

Test subject `expect() > rejects`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/expect.test.js:101:77)`.

Observed diagnostic:

```text
Received function did not throw
Received value: Promise { <pending> }
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:1099](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L1099). Reproducer `suite quickjs 'js/bun/test/expect.test.js'`.

<details>
<summary>All 7 member files</summary>

- `js/bun/test/expect.test.js`
- `js/node/fs/dir.test.ts`
- `js/node/fs/fs-path-length.test.ts`
- `js/web/encoding/encode-bad-chunks.test.ts`
- `regression/issue/02367.test.ts`
- `regression/issue/17605.test.ts`
- `regression/issue/26143.test.ts`

</details>

<a id="cause-zlib-zstd"></a>

### 16. Zstd stream constructors and compression functions are absent

7 files. Category `d`. The factory is undefined or explicitly unsupported before reset-race and compressed-data assertions.

Test subject `<collection>`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
# Unhandled error between tests -------------------------------
SyntaxError: Could not find export 'zstdCompress' in module 'bun'
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:674](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L674). Reproducer `suite quickjs 'js/bun/util/zstd.test.ts'`.

<details>
<summary>All 7 member files</summary>

- `js/bun/util/zstd.test.ts`
- `js/node/zlib/zlib-reset-race.test.ts`
- `js/web/streams/compression.test.ts`
- `regression/issue/20053.test.ts`
- `regression/issue/23314/zstd-async-compress.test.ts`
- `regression/issue/23314/zstd-large-decompression.test.ts`
- `regression/issue/23314/zstd-large-input.test.ts`

</details>

<a id="cause-shallow-memory"></a>

### 17. bun:jsc.estimateShallowMemoryUsageOf has no engine-independent implementation

5 files. Category `e`. All five files fail at the missing named export. Retain e because truthful parity needs per-engine object-layout and backing-store accounting, beyond the Engine memory_usage aggregate. Standard browser JavaScript exposes no per-object shallow size. Maintaining private JSC, QuickJS and browser heap-layout adapters solely for these internal size assertions has no portable consumer contract; fabricated sizes would invalidate the tests.

Test subject `<collection>`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
# Unhandled error between tests -------------------------------
SyntaxError: Could not find export 'estimateShallowMemoryUsageOf' in module 'bun:jsc'
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:813](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L813). Reproducer `suite quickjs 'js/bun/util/heap-snapshot.test.ts'`.

<details>
<summary>All 5 member files</summary>

- `js/bun/util/heap-snapshot.test.ts`
- `js/node/zlib/zlib-estimated-size-gc.test.ts`
- `js/web/abort/abort-signal-event-listener-leak.test.ts`
- `js/web/timers/performance-entries.test.ts`
- `js/web/websocket/websocket-pong-fragmented.test.ts`

</details>

<a id="cause-terminal"></a>

### 18. Bun.Terminal needs a PTY and termios host capability

5 files. Category `a`. All five members construct Bun.Terminal or require its PTY transport. WASI preview1 supplies no openpty, terminal-master/slave descriptors, termios or ioctl, and the host ABI exposes only ordinary child stdio pipes. The absent constructor is observed before PTY behavior can run. The delayed bash-pipe fixture is excluded from this cause because it creates no PTY.

Test subject `Bun.Terminal platform behaviour > GAP: termios flag accessors`. Throwing frame `at <anonymous> (/bun/test/js/bun/terminal/terminal-platform-gaps.test.ts:80:32)`.

Observed diagnostic:

```text
await using terminal = new Bun.Terminal({});                                     ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/terminal/terminal-platform-gaps.test.ts'`.

<details>
<summary>All 5 member files</summary>

- `js/bun/terminal/terminal-platform-gaps.test.ts`
- `js/bun/terminal/terminal-spawn.test.ts`
- `js/bun/terminal/terminal.test.ts`
- `js/node/tty.test.ts`
- `regression/issue/26286.test.ts`

</details>

<a id="cause-x509"></a>

### 19. node:crypto.X509Certificate is not exported

5 files. Category `d`. Collection stops on the missing certificate class. This is earlier than the WebSocket, structured-clone or regression behavior named by the affected files.

Test subject `<collection>`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
# Unhandled error between tests -------------------------------
SyntaxError: Could not find export 'X509Certificate' in module 'node:crypto'
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:181](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L181). Reproducer `suite quickjs 'js/web/websocket/websocket-client.test.ts'`.

<details>
<summary>All 5 member files</summary>

- `js/web/websocket/websocket-client.test.ts`
- `js/web/workers/structured-clone.test.ts`
- `regression/issue/21274.test.ts`
- `regression/issue/27025.test.ts`
- `regression/issue/31611.test.ts`

</details>

<a id="cause-manifest-accept"></a>

### 20. Registry requests send the wrong npm Accept header

5 files. Category `c`. Requests send application/vnd.npm.install-v1+json without the q=1.0, application/json;q=0.8 and wildcard alternatives expected by the fixture registry. The server assertion fails before package installation.

Test subject `--prefer-offline resolves from cached manifests without touching the network`. Throwing frame `at manifestVersionInfo (/bun/test/cli/install/dummy.registry.ts:63:63)`.

Observed diagnostic:

```text
Expected to contain: "application/vnd.npm.install-v1+json"
Received: [ "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*", "application/json, */*" ]
Expected to not contain: "error:"
Received: "error: GET http://localhost:34871/baz - 500\n"
```

Suspected implementation [crates/bunwasm-runtime/src/install/io.rs:111](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/io.rs#L111). Reproducer `suite quickjs 'cli/install/bun-install-offline.test.ts'`.

<details>
<summary>All 5 member files</summary>

- `cli/install/bun-install-offline.test.ts`
- `cli/install/bun-install-security-provider.test.ts`
- `cli/install/bun-pm.test.ts`
- `cli/install/bun-update.test.ts`
- `packages/registry/test/cli.test.ts`

</details>

<a id="cause-udp"></a>

### 21. UDP and resolver datagram sockets have no host ABI

5 files. Category `a`. The raw child errors identify Bun.udpSocket or dgram.createSocket; the other members create UDP sockets in their child source. Slots 6-9 and 16-17 implement TCP listen/connect/addresses/half-close, with no datagram bind/send/receive operations. Missing UDP host transport is the capability gap. General WASI networking is not absent.

Test subject `udpSocket() > setTTL does not crash when socket is closed during argument coercion`. Throwing frame `at <anonymous> (/bun/test/js/bun/udp/udp_socket.test.ts:51:22)`.

Observed diagnostic:

```text
- ""
+ "1 |
+ 2 |           const s = await Bun.udpSocket({});
+                                   ^
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789). Reproducer `suite quickjs 'js/bun/udp/udp_socket.test.ts'`.

<details>
<summary>All 5 member files</summary>

- `js/bun/udp/udp_socket.test.ts`
- `js/node/dns/dns-resolver-concurrent-timeout.test.ts`
- `js/node/dns/dns-tcp-bidirectional-poll.test.ts`
- `regression/issue/24157.test.ts`
- `regression/issue/28083.test.ts`

</details>

<a id="cause-zlib-brotli"></a>

### 22. Brotli compression and decompression are stubbed

4 files. Category `d`. Brotli creation or decoding throws ERR_NOT_SUPPORTED_IN_WASM before the intended error-code, output-size or reentrancy assertion.

Test subject `table-driven ERR_* codes keep their exact messages`. Throwing frame `at <anonymous> (/bun/test/js/node/errors/error-code-messages.test.ts:30:78)`.

Observed diagnostic:

```text
Expected: "ERR_BROTLI_INVALID_PARAM | RangeError | 99999 is not a valid Brotli parameter"
Received: "ERR_NOT_SUPPORTED_IN_WASM | Error | zlib.createBrotliCompress is not supported in bun-wasm: brotli is not compiled into bun.wasm"
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:674](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L674). Reproducer `suite quickjs 'js/node/errors/error-code-messages.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `js/node/errors/error-code-messages.test.ts`
- `js/node/zlib/zlib-onerror-reentrancy.test.ts`
- `js/node/zlib/zlib.kMaxLength.global.test.js`
- `js/node/zlib/zlib.test.js`

</details>

<a id="cause-post-run-flags"></a>

### 23. bun run treats following runtime options as a filename

4 files. Category `c`. The run arm consumes the next argument as a file before parsing --bun, --smol or --workspaces. Commands that native Bun accepts therefore load a flag as a module path.

Test subject `jsx-symbol-collision > should not have a symbol collision with jsx imports`. Throwing frame `at <anonymous> (/bun/test/cli/run/jsx-symbol-collision.test.ts:14:20)`.

Observed diagnostic:

```text
- "[Function: Fragment]
- "
+ ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:408](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L408). Reproducer `suite quickjs 'cli/run/jsx-symbol-collision.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `cli/run/jsx-symbol-collision.test.ts`
- `cli/run/workspaces.test.ts`
- `regression/issue/24387.test.ts`
- `regression/issue/26207.test.ts`

</details>

<a id="cause-update-command"></a>

### 24. bun update is absent

4 files. Category `d`. The update CLI is rejected before scanning advisories or drawing the interactive package table.

Test subject `security scanner blocks bun update on fatal advisory`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-update-security-provider.test.ts:108:20)`.

Observed diagnostic:

```text
-
- "bun update <version> (<revision>)
- scanner received: moo@0.2.0
+ ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:404](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L404). Reproducer `suite quickjs 'cli/install/bun-update-security-provider.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `cli/install/bun-update-security-provider.test.ts`
- `cli/install/bun-update-security-simple.test.ts`
- `cli/update_interactive_formatting.test.ts`
- `regression/issue/24131.test.ts`

</details>

<a id="cause-decorator-helper"></a>

### 25. bun:wrap has no __decorateElement export

4 files. Category `c`. The transpiler emits an import for the decorator runtime helper, but bun:wrap returns an empty object. The files fail during collection before any decorator metadata assertion.

Test subject `<collection>`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
# Unhandled error between tests -------------------------------
SyntaxError: Could not find export '__decorateElement' in module 'bun:wrap'
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:864](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L864). Reproducer `suite quickjs 'bundler/transpiler/decorator-metadata.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `bundler/transpiler/decorator-metadata.test.ts`
- `bundler/transpiler/decorators.test.ts`
- `integration/typegraphql/src/ts_example.test.ts`
- `integration/typegraphql/src/unsolvable.test.ts`

</details>

<a id="cause-cron"></a>

### 26. Bun.cron and Bun.cron.parse are absent

4 files. Category `d`. An invalid schedule produces not-a-function instead of validation, and cron.parse child programs have no output. In-process scheduling is distinct from installing OS cron jobs.

Test subject `Bun.cron.parse — local time zone > 0 9 * * * in America/Los_Angeles is 9am Pacific (PDT = UTC-7)`. Throwing frame `at evalInTZ (/bun/test/js/bun/cron/cron-local-time.test.ts:18:18)`.

Observed diagnostic:

```text
- ""
+ "1 | process.stdout.write(Bun.cron.parse("0 9 * * *", new Date("2026-06-15T00:00:00Z")).toISOString())
+                          ^
+ TypeError: cannot read property 'parse' of undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/cron/cron-local-time.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `js/bun/cron/cron-local-time.test.ts`
- `js/bun/cron/cron-parse.test.ts`
- `js/bun/cron/cron.test.ts`
- `js/bun/cron/in-process-cron.test.ts`

</details>

<a id="cause-markdown"></a>

### 27. Bun.markdown is absent

4 files. Category `d`. The named markdown import is undefined, so html cannot be called. GFM output, heading IDs and CommonMark cases have not reached a Markdown parser or renderer.

Test subject `tables interrupting paragraphs > table immediately after paragraph text`. Throwing frame `at render (/bun/test/js/bun/md/gfm-compat.test.ts:16:10)`.

Observed diagnostic:

```text
return markdown.html(input + "\n", options ?? {});               ^
TypeError: cannot read property 'html' of undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:455](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L455). Reproducer `suite quickjs 'js/bun/md/gfm-compat.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `js/bun/md/gfm-compat.test.ts`
- `js/bun/md/md-edge-cases.test.ts`
- `js/bun/md/md-heading-ids.test.ts`
- `js/bun/md/md-spec.test.ts`

</details>

<a id="cause-webview"></a>

### 28. Bun.WebView constructor and CDP client are absent

4 files. Category `d`. The first failures are missing constructor or option validation. The disconnect fixture uses a local Bun.serve WebSocket CDP mock, and the pipe fixture substitutes a Bun script for Chrome. These controls do not require a native GUI or installed browser. Implement the public WebView API before attributing a later transport failure to the host.

Test subject `navigate() rejects when the connection drops after the document committed`. Throwing frame `at runScenario (/bun/test/js/bun/webview/webview-chrome-disconnect.test.ts:112:26)`.

Observed diagnostic:

```text
Expected to end with: "}\n"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/webview/webview-chrome-disconnect.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `js/bun/webview/webview-chrome-disconnect.test.ts`
- `js/bun/webview/webview-chrome-pipe.test.ts`
- `js/bun/webview/webview-chrome.test.ts`
- `js/bun/webview/webview.test.ts`

</details>

<a id="cause-within"></a>

### 29. expect.toBeWithin is absent

4 files. Category `c`. Range assertions and validation tests call a missing matcher. A direct TypeError precedes any comparison of the received number.

Test subject `Glob.match > **/*.ts > gives the same answers however often it's asked, short paths first`. Throwing frame `at <anonymous> (/bun/test/js/bun/glob/match.test.ts:2927:30)`.

Observed diagnostic:

```text
expect(matches.length).toBeWithin(1, paths.length);                                     ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:851](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L851). Reproducer `suite quickjs 'js/bun/glob/match.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `js/bun/glob/match.test.ts`
- `js/bun/test/bun-test.test.ts`
- `js/bun/test/mock-fn.test.js`
- `js/third_party/jsonwebtoken/issue_147.test.js`

</details>

<a id="cause-resolve-wording"></a>

### 30. Resolver errors say package instead of module and omit structured diagnostics

4 files. Category `c`. Public module resolution diagnostics lack ResolveMessage identity and package.json parser notes. Match these structured errors rather than changing expected assertion strings.

Test subject `bun run --tsconfig-override > should use custom tsconfig for path resolution`. Throwing frame `at <anonymous> (/bun/test/cli/run/tsconfig-override.test.ts:47:24)`.

Observed diagnostic:

```text
Expected to contain: "Cannot find module"
Received: "error: Cannot find package '@helpers/math' from '/tmp/run-tsconfig-override_0Z4KkN/index.ts'\n specifier: \"@helpers/math\",\n      code: \"ERR_MODULE_NOT_FOUND\"\n\n\nBun v1.4.4 (WASI wasm32)\n"
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:83](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L83). Reproducer `suite quickjs 'cli/run/tsconfig-override.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `cli/run/tsconfig-override.test.ts`
- `js/bun/resolve/resolve-error.test.ts`
- `js/node/util/test-util-types.test.js`
- `regression/issue/25622.test.ts`

</details>

<a id="cause-s3-api"></a>

### 31. S3Client and Bun.s3 are absent

4 files. Category `d`. S3 operations fail at API construction or with TypeError before connection-close and stream assertions. This does not establish a network FIN handling defect.

Test subject `peer sends FIN: true > S3Client.write() resolves on a Content-Length: 0 + Connection: close response`. Throwing frame `at <anonymous> (/bun/test/js/bun/s3/s3-connection-close.test.ts:134:51)`.

Observed diagnostic:

```text
-   "exitCode": 0,
-   "stdout": "completed",
+   "exitCode": 1,
+   "stdout": "",
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/s3/s3-connection-close.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `js/bun/s3/s3-connection-close.test.ts`
- `js/bun/s3/s3-numeric-options-coerce.test.ts`
- `js/bun/s3/s3-storage-class.test.ts`
- `js/bun/s3/s3-write-to-file-sync-close.test.ts`

</details>

<a id="cause-lock-migration"></a>

### 32. The installer ignores existing npm, pnpm and Yarn lockfile migration

4 files. Category `d`. The installer resolves package.json and prints Saved lockfile without reading or reporting the old-format lockfile. Yarn fixtures may exit 1 before their expected migrated resolution.

Test subject `migrate from npm lockfile v3 during 'bun add'`. Throwing frame `at <anonymous> (/bun/test/cli/install/migration/migrate.test.ts:125:40)`.

Observed diagnostic:

```text
-
- "migrated lockfile from package-lock.json
- Resolving dependencies
+ "Saved lockfile"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:80](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L80). Reproducer `suite quickjs 'cli/install/migration/migrate.test.ts'`.

<details>
<summary>All 4 member files</summary>

- `cli/install/migration/migrate.test.ts`
- `cli/install/migration/pnpm-migration.test.ts`
- `cli/install/migration/yarn-berry.test.ts`
- `cli/install/migration/yarn-lock-migration.test.ts`

</details>

<a id="cause-web-brand"></a>

### 33. AbortController, EventTarget and CustomEvent lack their web toStringTag

3 files. Category `c`. Object.prototype.toString receives [object Object] instead of the appropriate branded web type.

Test subject `controllerHasProperToString`. Throwing frame `at ::bunternal:: (/bun/test/js/deno/harness.ts:105:20)`.

Observed diagnostic:

```text
Expected: "[object AbortController]"
Received: "[object Object]"
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:499](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L499). Reproducer `suite quickjs 'js/deno/abort/abort-controller.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/deno/abort/abort-controller.test.ts`
- `js/deno/event/custom-event.test.ts`
- `js/deno/event/event-target.test.ts`

</details>

<a id="cause-partial-assert"></a>

### 34. assert.partialDeepStrictEqual is absent

3 files. Category `c`. The assertion module has no partialDeepStrictEqual function. This is distinct from a deep equality algorithm returning the wrong value.

Test subject `assert.partialDeepStrictEqual > arrays match an in-order subsequence with partial element comparison`. Throwing frame `at <anonymous> (/bun/test/js/node/assert/assert.test.cjs:14:12)`.

Observed diagnostic:

```text
assert.partialDeepStrictEqual([1, 2, 3, 4], [2, 4]);                 ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/assert.js:661](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/assert.js#L661). Reproducer `suite quickjs 'js/node/assert/assert.test.cjs'`.

<details>
<summary>All 3 member files</summary>

- `js/node/assert/assert.test.cjs`
- `regression/issue/24338.test.ts`
- `regression/issue/28522.test.ts`

</details>

<a id="cause-stream-lock"></a>

### 35. Body and Node stream consumers release locks that Bun retains

3 files. Category `d`. After consumption body.locked is false while Bun's native-consumer contract expects true. Content equality alone does not cover this ownership contract.

Test subject `ReadableStream.blob() after body consumed does not crash`. Throwing frame `at <anonymous> (/bun/test/js/web/streams/readable-stream-blob-consumed.test.ts:10:23)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:890](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L890). Reproducer `suite quickjs 'js/web/streams/readable-stream-blob-consumed.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/web/streams/readable-stream-blob-consumed.test.ts`
- `regression/issue/07001.test.ts`
- `regression/issue/09555.test.ts`

</details>

<a id="cause-x-command"></a>

### 36. bun x and bunx execution are absent

3 files. Category `d`. The external-package runner exits before executing the package. This differs from an installed dependency failing inside its entry point.

Test subject `concurrent bunx spawns of the same package do not corrupt the shared install dir`. Throwing frame `at <anonymous> (/bun/test/cli/install/bunx-concurrent.test.ts:152:20)`.

Observed diagnostic:

```text
Expected to contain: "OK-37830 600"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:400](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L400). Reproducer `suite quickjs 'cli/install/bunx-concurrent.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/install/bunx-concurrent.test.ts`
- `js/third_party/pnpm/pnpm.test.ts`
- `regression/issue/15276.test.ts`

</details>

<a id="cause-archive-api-image"></a>

### 37. Bun.Image codec and resize API is absent

3 files. Category `d`. Image kernel and codec tests call an absent constructor. This does not establish that an implemented resize filter gives incorrect pixels.

Test subject `resize filter properties > nearest preserves a flat field exactly (sum-to-one + edge renormalisation)`. Throwing frame `at resizePixels (/bun/test/js/bun/image/image-kernels.test.ts:102:30)`.

Observed diagnostic:

```text
return decodePng(await new Bun.Image(src).resize(w, h, { filter }).png().bytes()).data;                                    ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/image/image-kernels.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/bun/image/image-kernels.test.ts`
- `js/bun/image/image-vs-sharp.test.ts`
- `js/bun/jsc-stress/fixtures/simd-baseline.test.ts`

</details>

<a id="cause-module-graph"></a>

### 38. Bun.ModuleGraph is absent

3 files. Category `d`. The constructor is undefined, including inside worker fixtures. Graph isolation, import and disposal assertions are not reached.

Test subject `ModuleGraph: what a graph opens is the graph's > run() calls fn in the graph's context and validates it; a subclass is a ModuleGraph`. Throwing frame `at <anonymous> (/bun/test/js/bun/module-graph/module-graph-io.test.ts:70:23)`.

Observed diagnostic:

```text
using graph = new Bun.ModuleGraph();                            ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/module-graph/module-graph-io.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/bun/module-graph/module-graph-io.test.ts`
- `js/bun/module-graph/module-graph-workers.test.ts`
- `js/bun/module-graph/module-graph.test.ts`

</details>

<a id="cause-unsafe-gc"></a>

### 39. Bun.unsafe.gcAggressionLevel is native GC test control

3 files. Category `e`. All three files call the absent gcAggressionLevel control before their subject runs. Retain e because this selects JSC-private collector policy, while the portable Engine interface supplies only gc and aggregate memory_usage. Standard browser workers expose no collector-policy control. Per-engine collector tuning plus tests of equivalent policy would maintain a private stress facility rather than public runtime behavior.

Test subject `<collection>`. Throwing frame `at /bun/test/js/bun/glob/scan.test.ts:32:35`.

Observed diagnostic:

```text
let origAggressiveGC = Bun.unsafe.gcAggressionLevel();                                        ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:511](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L511). Reproducer `suite quickjs 'js/bun/glob/scan.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/bun/glob/scan.test.ts`
- `js/bun/resolve/load-same-js-file-a-lot.test.ts`
- `js/node/v8/v8-date-parser.test.js`

</details>

<a id="cause-preload"></a>

### 40. bunfig preloads and preload-defined extensions are not applied

3 files. Category `d`. Preloaded code does not run in the required startup phase. The observed symptoms are missing custom matcher, missing text loader and missing preload stdout.

Test subject `preload > throws an error when preloaded module fails to execute`. Throwing frame `at <anonymous> (/bun/test/cli/run/preload-test.test.js:176:33)`.

Observed diagnostic:

```text
Expected to contain: "preload test failed"
Received: "error: Cannot find module './hey.txt' from '/tmp/bun-preload-test3/main.js'\n specifier: \"./hey.txt\",\n      code: \"ERR_MODULE_NOT_FOUND\"\n\n\nBun v1.4.4 (WASI wasm32)\n"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2341](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2341). Reproducer `suite quickjs 'cli/run/preload-test.test.js'`.

<details>
<summary>All 3 member files</summary>

- `cli/run/preload-test.test.js`
- `config/bunfig/preload.test.ts`
- `js/bun/test/expect-extend-preload.test.ts`

</details>

<a id="cause-child-ipc"></a>

### 41. Child IPC and process.send are unsupported

3 files. Category `b`. Fresh guests cannot exchange the requested IPC messages or send callbacks. node:worker_threads messaging is a separate capability.

Test subject `ipc with json serialization still works when bun is parent and not the child`. Throwing frame `at <anonymous> (/bun/test/js/bun/spawn/spawn.ipc.bun-node.test.ts:10:51)`.

Observed diagnostic:

```text
- p end
- c start
- c end
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:69](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L69). Reproducer `suite quickjs 'js/bun/spawn/spawn.ipc.bun-node.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/bun/spawn/spawn.ipc.bun-node.test.ts`
- `js/node/child_process/child_process_ipc_large_disconnect.test.js`
- `js/node/child_process/child_process_send_cb.test.js`

</details>

<a id="cause-conditional-tests"></a>

### 42. Conditional and each test builders lose their modifier methods

3 files. Category `c`. Bound test builders do not retain every conditional or each modifier. Collection can fail before the file registers its tests.

Test subject `<collection>`. Throwing frame `at <anonymous> (/bun/test/cli/run/run-autoinstall.test.ts:1392:21)`.

Observed diagnostic:

```text
const cell = test.concurrentIf(!isASAN);                            ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:1810](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L1810). Reproducer `suite quickjs 'cli/run/run-autoinstall.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/run/run-autoinstall.test.ts`
- `js/bun/console/console-write.test.ts`
- `js/bun/test/jest-each-gc-root.test.ts`

</details>

<a id="cause-fs-error-fields"></a>

### 43. Filesystem wrappers lose Node error code and path fields

3 files. Category `c`. Examples receive undefined for ENOENT, EEXIST or error.path. Preserve structured syscall errors through the callback and promise adapters.

Test subject `Bun.write > Bun.write file not found returns ENOENT, issue#6336`. Throwing frame `at <anonymous> (/bun/test/js/bun/io/bun-write.test.js:121:30)`.

Observed diagnostic:

```text
Expected: "ENOENT"
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:30](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L30). Reproducer `suite quickjs 'js/bun/io/bun-write.test.js'`.

<details>
<summary>All 3 member files</summary>

- `js/bun/io/bun-write.test.js`
- `js/node/fs/cp.test.ts`
- `js/node/fs/promises.test.js`

</details>

<a id="cause-http-header-case"></a>

### 44. HTTP and WebSocket serializers lowercase caller-visible header names

3 files. Category `c`. The bytes contain date, upgrade or x-latin1 while fixtures expect Date, Upgrade or X-Latin1. Values are present. Preserve observable raw spelling where Bun's APIs promise it.

Test subject `WebSocket upgrade with non-ASCII inputs > Latin1 header value with high bytes is sent as UTF-8 without crashing`. Throwing frame `at <anonymous> (/bun/test/js/web/websocket/websocket-utf16-headers.test.ts:102:18)`.

Observed diagnostic:

```text
Expected to contain: "X-Latin1:"
Received: "GET / HTTP/1.1\r\nconnection: Upgrade\r\nhost: 127.0.0.1:46733\r\nsec-websocket-key: TsI8QPmmoUoW1fFNOw3AVw==\r\nsec-websocket-version: 13\r\nupgrade: websocket\r\nx-latin1: vàlüé-ñ\r\n\r\n"
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:1](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L1). Reproducer `suite quickjs 'js/web/websocket/websocket-utf16-headers.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/web/websocket/websocket-utf16-headers.test.ts`
- `regression/issue/21677.test.ts`
- `regression/issue/23474.test.ts`

</details>

<a id="cause-install-lockfile-only"></a>

### 45. Installer lacks --lockfile-only mode

3 files. Category `c`. The flag is rejected before metadata-only resolution. These are not evidence of downloading too many tarballs or a semver intersection bug.

Test subject `should not download tarballs with --lockfile-only using bun.lockb`. Throwing frame `at <anonymous> (/bun/test/cli/install/lockfile-only.test.ts:73:24)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/lockfile-only.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/install/lockfile-only.test.ts`
- `cli/install/semver.test.ts`
- `regression/issue/36577.test.ts`

</details>

<a id="cause-file-dependencies"></a>

### 46. Installer resolution does not handle local file dependency graphs

3 files. Category `d`. The initial add of file:pkg fails before remove is reached. Other fixtures stop before local scoped dependencies or catalog peers are installed. Inspect local-spec parsing and resolution, not remove's output formatting.

Test subject `should remove existing package`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-remove.test.ts:53:27)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/resolve.rs:56](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/resolve.rs#L56). Reproducer `suite quickjs 'cli/install/bun-remove.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/install/bun-remove.test.ts`
- `regression/issue/26337.test.ts`
- `regression/issue/40561.test.ts`

</details>

<a id="cause-ffi"></a>

### 47. Native FFI libraries and addon loading are unavailable

3 files. Category `a`. These members require dlopen of host libc for raw descriptors or mmap, or compile-and-call of a native C function. The wasm32-wasip1 guest cannot load an ELF/Mach-O/DLL into its linear memory and execute host machine code. The host ABI has no native-library or foreign-call operation. This is separate from reporting the right code when a load is rejected.

Test subject `PipeReader is freed when a subprocess stdout read fails`. Throwing frame `at <anonymous> (/bun/test/js/bun/spawn/spawn-pipe-read-error-leak.test.ts:141:25)`.

Observed diagnostic:

```text
- []
+ [
+   "2 | const { dlopen, FFIType } = require("bun:ffi");",
+   "3 | const { readdirSync, readlinkSync, openSync, closeSync, writeFileSync, rmSync } = require("fs");",
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:808](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L808). Reproducer `suite quickjs 'js/bun/spawn/spawn-pipe-read-error-leak.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/bun/spawn/spawn-pipe-read-error-leak.test.ts`
- `js/bun/transpiler/transpiler-truncated-utf8.test.ts`
- `regression/issue/26249.test.ts`

</details>

<a id="cause-install-integrity"></a>

### 48. Package resolution requires dist.integrity or dist.shasum

3 files. Category `c`. A fixture manifest without either integrity field is rejected before tarball processing. Inspect the selected registry metadata contract rather than security-scanner assertions.

Test subject `bun install > no args > --linker=hoisted > (scanner: npm) > (bun.lock exists: false) > (advisories: warn) > (TTY:n) > 0019 (with modules)`. Throwing frame `at runSecurityScannerTest (/bun/test/cli/install/bun-security-scanner-matrix-runner.ts:434:17)`.

Observed diagnostic:

```text
throw new Error(`setup install exited with ${setup.exitCode}:\n${setup.stderr}`);                       ^
error: setup install exited with 1:
```

Suspected implementation [crates/bunwasm-runtime/src/install/resolve.rs:409](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/resolve.rs#L409). Reproducer `suite quickjs 'cli/install/bun-security-scanner-matrix-with-node-modules.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/install/bun-security-scanner-matrix-with-node-modules.test.ts`
- `cli/install/bun-security-scanner-matrix-without-node-modules.test.ts`
- `cli/install/bun-update-security-edge-cases.test.ts`

</details>

<a id="cause-stdout-lifecycle"></a>

### 49. process.stdout end, drain and async iteration contracts are incomplete

3 files. Category `d`. A write after end succeeds with null callback error and writable true. Other fixtures find no async iterator or cannot observe the expected final byte count.

Test subject `process.stdout - write after end() errors and is not delivered (piped)`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-stdout-write-after-end.test.ts:27:20)`.

Observed diagnostic:

```text
-   "cbErr": "ERR_STREAM_WRITE_AFTER_END",
-   "ev": [
-     "err:ERR_STREAM_WRITE_AFTER_END",
+   "cbErr": null,
+   "ev": [],
+   "ret": true,
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:68](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L68). Reproducer `suite quickjs 'js/node/process/process-stdout-write-after-end.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `js/node/process/process-stdout-write-after-end.test.ts`
- `regression/issue/25432.test.ts`
- `regression/issue/test-process-stdout-async-iterator.test.ts`

</details>

<a id="cause-autoinstall"></a>

### 50. Runtime resolution does not auto-install package specifiers

3 files. Category `d`. A versioned uglify-js specifier is sent to ordinary node_modules resolution and rejected. Cached-manifest and invalid-name controls also fail to reach their child marker. Inspect auto-install entry selection before package execution.

Test subject `should download dependency to run local file`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-run-dir.test.ts:33:16)`.

Observed diagnostic:

```text
- ""
+ "1 |
+ 2 | const { minify } = require("uglify-js@3.17.4");
+                        ^
```

Suspected implementation [crates/bunwasm-runtime/src/resolve.rs:160](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/resolve.rs#L160). Reproducer `suite quickjs 'cli/install/bun-run-dir.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/install/bun-run-dir.test.ts`
- `cli/run/autoinstall-cached-manifest.test.ts`
- `js/bun/resolve/resolve-autoinstall-invalid-name.test.ts`

</details>

<a id="cause-install-equals-linker"></a>

### 51. The installer rejects --linker=hoisted while accepting the spaced form

3 files. Category `c`. The equals-form flag reaches the unknown-option arm. This is CLI parsing, not a backend copy or patch-application failure.

Test subject `install backends on POSIX > hardlink backend reports a file whose relative path exceeds PATH_MAX`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-install-backends.test.ts:181:22)`.

Observed diagnostic:

```text
Expected to contain: "ENAMETOOLONG: failed copying files from cache to destination for package pkg"
Received: "error: Unknown install option: --linker=hoisted\n"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/bun-install-backends.test.ts'`.

<details>
<summary>All 3 member files</summary>

- `cli/install/bun-install-backends.test.ts`
- `cli/install/bun-install-retry.test.ts`
- `regression/issue/patch-bounds-check.test.ts`

</details>

<a id="cause-source-map-diagnostic"></a>

### 52. BuildError diagnostics do not expose line and column positions

2 files. Category `d`. The child reads line and column from the build error position, but JSON serialization produces {}. Keep this missing structured position data separate from parser wording and stack remapping.

Test subject `lone 0xF0 byte reports column 2, not 3, and does not panic`. Throwing frame `at <anonymous> (/bun/test/js/bun/css/invalid-utf8-column.test.ts:38:37)`.

Observed diagnostic:

```text
-   "stdout": "{"line":1,"column":2}",
+   "stdout": "{}",
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:366](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L366). Reproducer `suite quickjs 'js/bun/css/invalid-utf8-column.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/css/invalid-utf8-column.test.ts`
- `js/bun/transpiler/parse-error-column.test.ts`

</details>

<a id="cause-info-why-command"></a>

### 53. bun info and why are absent

2 files. Category `d`. Metadata and dependency-explanation commands are rejected before their output can be produced.

Test subject `bun info > bun info (main command) > should display package info for latest version`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-info.test.ts:146:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:401](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L401). Reproducer `suite quickjs 'cli/install/bun-info.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/bun-info.test.ts`
- `cli/install/bun-pm-why.test.ts`

</details>

<a id="cause-patch-command"></a>

### 54. bun patch and prune commands are absent

2 files. Category `d`. The commands exit before patch validation or pruning. Empty stdout is not a snapshot serializer defect.

Test subject `error messages > 'bun patch' with no package name shows a usage example`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-patch.test.ts:156:42)`.

Observed diagnostic:

```text
-
- "error: Missing package name to patch.
-   Usage: bun patch <package>[@<version>]
+ "error: bun patch is not supported in bun-wasm"
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:404](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L404). Reproducer `suite quickjs 'cli/install/bun-patch.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/bun-patch.test.ts`
- `cli/install/bun-prune.test.ts`

</details>

<a id="cause-pm-migrate"></a>

### 55. bun pm migrate is absent

2 files. Category `d`. The requested migration subcommand is rejected before importing the lockfile. This is separate from implicit install-time lockfile migration.

Test subject `package-lock.json migration fixes > arborist fixtures > audit-fix-old-tap`. Throwing frame `at <anonymous> (/bun/test/cli/install/migration/npm-arborist.test.ts:19:33)`.

Observed diagnostic:

```text
- "migrated lockfile from package-lock.json
- bun pm migrate exit code: 0
- bun install --frozen-lockfile exit code: 0
+ "error: Only bun pm ls is supported in bun-wasm
+ bun pm migrate exit code: 1"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:451](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L451). Reproducer `suite quickjs 'cli/install/migration/npm-arborist.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/migration/npm-arborist.test.ts`
- `cli/install/migration/pnpm-lock-v9.test.ts`

</details>

<a id="cause-css-test-hook"></a>

### 56. bun:internal-for-testing.cssInternals.minifyTest is absent

2 files. Category `c`. The angle fixture cannot destructure minifyTest from undefined cssInternals. The nesting fixture catches the same missing helper and prints its TypeError instead of a nesting-limit diagnostic. Bun's CSS parser is already portable Rust in this project. No OS limitation or exclusion cost is established for exposing the test adapter.

Test subject `huge and non-finite radian angle values serialize instead of hanging`. Throwing frame `at <anonymous> (/bun/test/js/bun/css/angle-serialization-hang.test.ts:54:18)`.

Observed diagnostic:

```text
- ""
+ "TypeError: Cannot convert undefined or null to object
+       at /bun/test/[eval]:1:1
+
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:840](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L840). Reproducer `suite quickjs 'js/bun/css/angle-serialization-hang.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/css/angle-serialization-hang.test.ts`
- `js/bun/css/nested-selector-expansion.test.ts`

</details>

<a id="cause-runner-onfinished"></a>

### 57. bun:test.onTestFinished is absent

2 files. Category `c`. The fixture fails during import, so its expected repeated pass count cannot be measured.

Test subject `<collection>`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
# Unhandled error between tests -------------------------------
SyntaxError: Could not find export 'onTestFinished' in module 'bun:test'
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2385](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2385). Reproducer `suite quickjs 'js/bun/test/test-on-test-finished.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/test/test-on-test-finished.test.ts`
- `js/bun/test/test-retry-repeats-basic.test.ts`

</details>

<a id="cause-slice-ansi"></a>

### 58. Bun.sliceAnsi is absent

2 files. Category `c`. The missing exported function prevents width and ANSI-preserving slice assertions from running.

Test subject `sliceAnsi invariants > output width never exceeds requested range`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/sliceAnsi-fuzz.test.ts:37:23)`.

Observed diagnostic:

```text
const out = Bun.sliceAnsi(s, a, b);                            ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/util/sliceAnsi-fuzz.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/util/sliceAnsi-fuzz.test.ts`
- `js/bun/util/sliceAnsi.test.ts`

</details>

<a id="cause-wrap-ansi"></a>

### 59. Bun.wrapAnsi is absent

2 files. Category `c`. The missing exported function prevents word wrapping assertions from running.

Test subject `wraps string at 20 characters`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/wrapAnsi.npm.test.ts:50:22)`.

Observed diagnostic:

```text
const result = Bun.wrapAnsi(fixture, 20);                           ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/util/wrapAnsi.npm.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/util/wrapAnsi.npm.test.ts`
- `js/bun/util/wrapAnsi.test.ts`

</details>

<a id="cause-ci-only"></a>

### 60. CI detection does not reject test.only

2 files. Category `c`. CI-only fixtures execute and pass .only tests instead of exiting 1 with the restriction diagnostic.

Test subject `CI detection > CI=true enables CI detection even with no CI env vars`. Throwing frame `at performTest (/bun/test/cli/env/ci-info.test.ts:27:20)`.

Observed diagnostic:

```text
Expected to contain: ".only is disabled in CI environments"
Received: "\nci-info.fixture.ts:\n(pass) only\n\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [2.08ms]\n"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:1840](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L1840). Reproducer `suite quickjs 'cli/env/ci-info.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/env/ci-info.test.ts`
- `js/bun/test/ci-restrictions.test.ts`

</details>

<a id="cause-cjs-interop"></a>

### 61. CommonJS namespace interop exposes the wrong default and __esModule shape

2 files. Category `d`. The __esModule object becomes undefined in one direction. require of the ESM wrapper adds an extra default object in the other. Inspect namespace conversion boundaries.

Test subject `without type: "module" > exports.__esModule = true`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/esModule-annotation.test.js:20:72)`.

Observed diagnostic:

```text
- {
-   "__esModule": true,
- }
+ undefined
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:383](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L383). Reproducer `suite quickjs 'js/bun/resolve/esModule-annotation.test.js'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/resolve/esModule-annotation.test.js`
- `js/bun/resolve/require.test.ts`

</details>

<a id="cause-url-idna"></a>

### 62. domainToASCII and domainToUnicode accept invalid domain input

2 files. Category `c`. Invalid a@b becomes b and malformed punycode is returned as text instead of the required empty string.

Test subject `url.domainToASCII > -> 'a@b' is ''`. Throwing frame `at <anonymous> (/bun/test/js/node/url/url-domain-ascii-unicode.test.js:85:40)`.

Observed diagnostic:

```text
Expected: ""
Received: "b"
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_url.js:167](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_url.js#L167). Reproducer `suite quickjs 'js/node/url/url-domain-ascii-unicode.test.js'`.

<details>
<summary>All 2 member files</summary>

- `js/node/url/url-domain-ascii-unicode.test.js`
- `regression/issue/24191.test.ts`

</details>

<a id="cause-eval-data-url"></a>

### 63. Dynamic data URL modules are resolved as package names

2 files. Category `d`. The generated syntax fixture reports Cannot find package data:text for a data URL import. The ESM registry stress fixture also imports data URLs before its completion marker. The resolver lacks data-module handling; the GC-oriented test name does not establish a GC failure.

Test subject `exit code 0 > eval #0: " "`. Throwing frame `at <anonymous> (/bun/test/cli/run/syntax.test.ts:394:74)`.

Observed diagnostic:

```text
-   "exitCode": 0,
-   "result": "PASS",
+   "exitCode": 1,
+   "result": "FAIL: Cannot find package 'data:text' from '/tmp/syntax-fixture_kiVhES/[eval]'",
```

Suspected implementation [crates/bunwasm-runtime/src/resolve.rs:160](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/resolve.rs#L160). Reproducer `suite quickjs 'cli/run/syntax.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/run/syntax.test.ts`
- `js/node/module/esm-registry-concurrent-gc.test.ts`

</details>

<a id="cause-runner-format"></a>

### 64. Error frames and diff printing diverge from Bun's assertion report

2 files. Category `c`. Error source columns, stack frame suppression and rendered diffs differ. The diffexample snapshot grows from 436 to 20,420 lines, so a trailing-newline fix would not address it.

Test subject `no color`. Throwing frame `at <anonymous> (FILE:LINE)`.

Observed diagnostic:

```text
- test/js/bun/test/printing/diffexample.fixture.ts:
- 10 |     .replaceAll("\\", "/")
- 11 |     .replaceAll(process.cwd(), "<cwd>");
+ js/bun/test/printing/diffexample.fixture.ts:
+ 10 |     .replaceAll("\\", "/")
+ 11 |     .replaceAll(process.cwd(), "<cwd>");
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2018](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2018). Reproducer `suite quickjs 'js/bun/test/printing/diffexample.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/test/printing/diffexample.test.ts`
- `regression/issue/19850/19850.test.ts`

</details>

<a id="cause-stack-map"></a>

### 65. Error stacks are not remapped through the expected source maps

2 files. Category `d`. The external-map fixture finds zero remapped frames instead of 17000. The internal-map fixture also exposes generated positions that native Bun hides. Inspect map registration and stack formatting together.

Test subject `error.stack with an external source map does not leak the remapped file names > stack`. Throwing frame `at <anonymous> (/bun/test/js/bun/sourcemap/external-sourcemap-stack-leak.test.ts:122:30)`.

Observed diagnostic:

```text
Expected: 17000
Received: 0
```

Suspected implementation [crates/bunwasm-runtime/src/js/stack_trace.js:57](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/stack_trace.js#L57). Reproducer `suite quickjs 'js/bun/sourcemap/external-sourcemap-stack-leak.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/sourcemap/external-sourcemap-stack-leak.test.ts`
- `js/bun/sourcemap/internal-sourcemap.test.ts`

</details>

<a id="cause-eval-jsx"></a>

### 66. Eval mode does not provide native Bun's TSX and React evaluation behavior

2 files. Category `d`. Eval does not provide Bun's JSX parsing path. The valid React/TSX fixture emits no expected output, while the malformed JSX fixture receives QuickJS's unexpected less-than-token message instead of Bun's JSX lexer diagnostics. This needs eval loader and transpilation work; the invalid JSX record alone does not establish an unavoidable engine-wording exclusion.

Test subject `bun -e > import, tsx, require in esm, import.meta`. Throwing frame `at <anonymous> (/bun/test/cli/run/run-eval.test.ts:35:39)`.

Observed diagnostic:

```text
- "{"version":"18.3.1","file":"/bun/test/[eval]","require":"18.3.1"}
- <hello>world</hello>
- "
+ ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:87](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L87). Reproducer `suite quickjs 'cli/run/run-eval.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/run/run-eval.test.ts`
- `regression/issue/jsx-template-string-crash.test.ts`

</details>

<a id="cause-extend-validation"></a>

### 67. expect.extend silently accepts non-callable entries

2 files. Category `c`. Invalid matcher values should throw TypeError. The registry skips non-functions, so the tested callback returns undefined without throwing.

Test subject `throws descriptive errors for invalid matchers`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/expect-extend.test.js:208:5)`.

Observed diagnostic:

```text
Expected substring: "expect.extend: `_default` is not a valid matcher. Must be a function, is \"undefined\""
Received function did not throw
Received value: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:783](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L783). Reproducer `suite quickjs 'js/bun/test/expect-extend.test.js'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/test/expect-extend.test.js`
- `regression/issue/fuzzer-ENG-22942.test.ts`

</details>

<a id="cause-pass-fail-matchers"></a>

### 68. expect.pass and expect.fail are absent

2 files. Category `c`. The throwing call names the missing matcher. In the memory-growth fixture expect.fail is a secondary diagnostic path, so adding it cannot prove the memory assertion passes.

Test subject `override is an accessibility modifier`. Throwing frame `at <anonymous> (/bun/test/regression/issue/07324.test.ts:20:12)`.

Observed diagnostic:

```text
expect().pass();                 ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:851](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L851). Reproducer `suite quickjs 'regression/issue/07324.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `regression/issue/07324.test.ts`
- `regression/issue/28756.test.ts`

</details>

<a id="cause-install-registry-config"></a>

### 69. Installer does not honor scoped npmrc registry URL paths

2 files. Category `c`. The local registry sees no /r/default or /r/scoped manifest requests. Frozen-lockfile control rejects changes rather than requesting the scoped registry. Inspect registry selection and path joining together.

Test subject `registry path without trailing slash is preserved > .npmrc registry= and @scope:registry=`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-install-pathname-trailing-slash.test.ts:120:35)`.

Observed diagnostic:

```text
- [
-   "/r/default/react",
-   "/r/scoped/@scoped%2fpkg",
+ []
```

Suspected implementation [crates/bunwasm-runtime/src/install/io.rs:29](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/io.rs#L29). Reproducer `suite quickjs 'cli/install/bun-install-pathname-trailing-slash.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/bun-install-pathname-trailing-slash.test.ts`
- `regression/issue/026039.test.ts`

</details>

<a id="cause-install-platform"></a>

### 70. Installer does not parse --cpu, --os or --libc overrides

2 files. Category `c`. The requested platform override reaches the unknown-option arm before dependency CPU, OS or libc filtering. This differs from an actual wrong dependency-filter result.

Test subject `bun install --cpu and --os flags > should filter dependencies by CPU architecture`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-install-cpu-os.test.ts:62:22)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/bun-install-cpu-os.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/bun-install-cpu-os.test.ts`
- `cli/install/bun-install-native-binlink.test.ts`

</details>

<a id="cause-install-backend"></a>

### 71. Installer rejects --backend and --backend=hardlink

2 files. Category `c`. The backend option is unrecognized in either form. The fixture has not reached native hardlink, clonefile or copy behavior.

Test subject `self-contained workspace via installConfig.hoistingLimits in the workspace's package.json > gets a complete, physical node_modules while other workspaces still hoist`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-workspaces-self-contained.test.ts:116:23)`.

Observed diagnostic:

```text
Expected to not contain: "error:"
Received: "error: Unknown install option: --backend=hardlink\n"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/bun-workspaces-self-contained.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/bun-workspaces-self-contained.test.ts`
- `regression/issue/08093.test.ts`

</details>

<a id="cause-expect-label"></a>

### 72. Matcher failures omit the custom expectation label

2 files. Category `c`. The comparison values are correct, but the supplied label such as lol! or <blue>label</blue> never reaches the failure message. Match this public assertion diagnostic.

Test subject `expect() failure messages preserve <...> in user data > colors disabled: angle-bracketed strings render verbatim`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/expect-failure-message-angle-brackets.test.ts:87:20)`.

Observed diagnostic:

```text
Expected to contain: "error: <blue>label</blue>"
Received: "\nangle.test.ts:\n1 | \n2 | import { test, expect } from \"bun:test\";\n3 | \n4 | test(\"toBe html\", () => {\n5 |   expect('<div class=\"active\">Hello</div>').toBe('<div class=\"inactive\">Hello</div>');\n
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:726](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L726). Reproducer `suite quickjs 'js/bun/test/expect-failure-message-angle-brackets.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/test/expect-failure-message-angle-brackets.test.ts`
- `js/bun/test/expect-label.test.ts`

</details>

<a id="cause-profiler-flags"></a>

### 73. Native CPU and heap profiler CLI output is unavailable

2 files. Category `e`. The observed first blocker is CLI rejection of the profiling flag. Retain e for the full feature cost: separate allocation/CPU sampling hooks and native profile writers for every engine. The Engine interface supplies aggregate memory and GC only, not samples, and browser workers have no standard allocation-profile or CPU-profile export. Adding a flag stub would not produce the requested truthful profile artifacts.

Test subject `--heap-prof writes a .heapprofile with node's filename format on exit`. Throwing frame `at <anonymous> (/bun/test/cli/heap-prof.test.ts:39:25)`.

Observed diagnostic:

```text
Expected: "done"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:416](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L416). Reproducer `suite quickjs 'cli/heap-prof.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/heap-prof.test.ts`
- `regression/issue/29240.test.ts`

</details>

<a id="cause-f-fetch-retry"></a>

### 74. Native fetch does not recover a closed pooled connection

2 files. Category `f`. The chunked fixture rejects with ConnectionClosed and the GET fixture parses empty response text. Browser fully passes both files. Inspect retry policy at the host fetch boundary.

Test subject `chunked uncompressed body over a retried keep-alive connection`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
js/web/fetch/fetch-retry-chunked.test.ts:
TypeError: error sending request for url (http://127.0.0.1:45801/): client error (SendRequest): connection closed before message completed fetching "http://127.0.0.1:45801/"
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:150](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L150). Reproducer `suite quickjs 'js/web/fetch/fetch-retry-chunked.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/web/fetch/fetch-retry-chunked.test.ts`
- `regression/issue/28706.test.ts`

</details>

<a id="cause-fetch-proxy"></a>

### 75. Native fetch ignores explicit proxy selection

2 files. Category `d`. The explicit proxy request reaches origin instead of proxy. The proxy CONNECT failure fixture also never observes the expected error span. Inspect request option forwarding at the fetch host boundary.

Test subject `app workloads > keeps the machine's proxy settings away from the app: direct stays direct, and its own proxy is used`. Throwing frame `at <anonymous> (/bun/test/js/bun/perf/linker-order.test.ts:607:57)`.

Observed diagnostic:

```text
-   "stdout": "{"direct":"origin","proxied":"proxy"}",
+   "stdout": "{"direct":"origin","proxied":"origin"}",
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:150](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L150). Reproducer `suite quickjs 'js/bun/perf/linker-order.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/perf/linker-order.test.ts`
- `js/node/trace_events/trace-events.test.ts`

</details>

<a id="cause-f-atomics"></a>

### 76. QuickJS is built without Atomics

2 files. Category `f`. Atomics is undefined on QuickJS. The WebKit-upgrade file fully passes on both JSC and browser; the waitAsync fixture fully passes on browser. Keep RegExp.escape's later supplementary-character failure separate from the first blocker.

Test subject `WebKit ccdcb8a026 upgrade > Atomics.isLockFree uses ToIntegerOrInfinity instead of wrapping to int32 (41294576ac)`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/webkit-upgrade-ccdcb8a026.test.ts:17:12)`.

Observed diagnostic:

```text
expect(Atomics.isLockFree(4)).toBe(true);                 ^
ReferenceError: Atomics is not defined
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:138](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L138). Reproducer `suite quickjs 'js/bun/jsc/webkit-upgrade-ccdcb8a026.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/jsc/webkit-upgrade-ccdcb8a026.test.ts`
- `regression/issue/atomics-waitasync-wtftimer-uaf.test.ts`

</details>

<a id="cause-f-parser-wording"></a>

### 77. QuickJS parser and builtin messages differ from JSC

2 files. Category `f`. The regex error is duplicate group name instead of Invalid regular expression: duplicate group specifier name. JSON.parse has V8-style wording instead of JSON Parse error. JSC fully passes both files. These are measured differences, not automatic cost exclusions; keep the separate recursive-array-join behavior failure visible.

Test subject `a SyntaxError from JavaScriptCore's parser with no JS frame on the stack has the parser's line and sourceURL`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/webkit-upgrade-9b02218df6.test.ts:26:25)`.

Observed diagnostic:

```text
Expected: "Invalid regular expression: duplicate group specifier name"
Received: "duplicate group name"
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:243](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L243). Reproducer `suite quickjs 'js/bun/jsc/webkit-upgrade-9b02218df6.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/bun/jsc/webkit-upgrade-9b02218df6.test.ts`
- `regression/issue/yaml-parse-syntax-error.test.ts`

</details>

<a id="cause-formdata-body"></a>

### 78. Request body normalization stringifies FormData instead of encoding multipart data

2 files. Category `d`. Content-Type becomes text/plain;charset=utf-8 instead of multipart/form-data with a boundary. Inspect FormData body serialization and Node stream interoperability together.

Test subject `boundary does not have quotes (#7917)`. Throwing frame `at <anonymous> (/bun/test/regression/issue/07917/7917.test.ts:18:24)`.

Observed diagnostic:

```text
Expected: "multipart/form-data; boundary=bject FormData]"
Received: "text/plain;charset=utf-8"
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:881](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L881). Reproducer `suite quickjs 'regression/issue/07917/7917.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `regression/issue/07917/7917.test.ts`
- `regression/issue/26225.test.ts`

</details>

<a id="cause-decorators"></a>

### 79. Runtime TypeScript loading does not emit the requested legacy decorator behavior

2 files. Category `d`. The computed decorated property fixture emits invalid JavaScript that QuickJS rejects with Unexpected token before any decorator marker. The metadata fixture also prints no decorated:world marker. Inspect tsconfig selection and decorator lowering in runtime TypeScript loading.

Test subject `does not segfault`. Throwing frame `at <anonymous> (/bun/test/regression/issue/10887.test.ts:38:36)`.

Observed diagnostic:

```text
- ""
+ "SyntaxError: Unexpected token '{'
+       at <anonymous> (/tmp/10887_NUZPol/index.ts:1:8)
+
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:87](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L87). Reproducer `suite quickjs 'regression/issue/10887.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `regression/issue/10887.test.ts`
- `regression/issue/27526.test.ts`

</details>

<a id="cause-compiled-bytecode"></a>

### 80. Standalone compilation and native bytecode tooling are absent

2 files. Category `d`. The child compile command exits 1 before bytecode tooling or embedded-file paths can be checked. This is missing CLI compilation support, not a source-map assertion bug.

Test subject `(unnamed)`. Throwing frame `at <anonymous> (/bun/test/cli/inspect/compile-bytecode-tooling.test.ts:206:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:259](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L259). Reproducer `suite quickjs 'cli/inspect/compile-bytecode-tooling.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/inspect/compile-bytecode-tooling.test.ts`
- `regression/issue/31575.test.ts`

</details>

<a id="cause-dotenv"></a>

### 81. Startup does not load the requested dotenv files

2 files. Category `d`. The child sees undefined instead of bar or hello_world. The CLI does not implement Bun's dotenv initialization or --no-env-file behavior.

Test subject `--no-env-file disables .env loading`. Throwing frame `at <anonymous> (/bun/test/cli/run/no-envfile.test.ts:23:27)`.

Observed diagnostic:

```text
Expected: "bar"
Received: "undefined"
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:439](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L439). Reproducer `suite quickjs 'cli/run/no-envfile.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/run/no-envfile.test.ts`
- `regression/issue/test_env_loader_threading.test.ts`

</details>

<a id="cause-subprocess-resource"></a>

### 82. Subprocess.resourceUsage returns undefined

2 files. Category `c`. The harness child reads resourceUsage().maxRSS and throws before returning its measurement. Do not interpret the assertion as measured child RSS.

Test subject `bun lint: the rules of the React Compiler report what oxlint 1.87.0 reports > for oxlint's own test cases`. Throwing frame `at lint (/bun/test/cli/lint/react-compiler.test.ts:49:16)`.

Observed diagnostic:

```text
peak: proc.resourceUsage()!.maxRSS,                     ^
TypeError: cannot read property 'maxRSS' of undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:228](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L228). Reproducer `suite quickjs 'cli/lint/react-compiler.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/lint/react-compiler.test.ts`
- `internal/harness-max-rss.test.ts`

</details>

<a id="cause-install-isolated"></a>

### 83. The installer only implements the hoisted linker

2 files. Category `d`. Isolated layout tests receive hoisted node_modules entries or an explicit unsupported-linker error instead of a .bun store.

Test subject `basic > transitive dependencies`. Throwing frame `at <anonymous> (/bun/test/cli/install/isolated-install.test.ts:197:67)`.

Observed diagnostic:

```text
-   ".bun",
+   "@types",
+   "no-deps",
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:50](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L50). Reproducer `suite quickjs 'cli/install/isolated-install.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/install/isolated-install.test.ts`
- `cli/install/isolated-relink.test.ts`

</details>

<a id="cause-retry-rerun"></a>

### 84. The test runner ignores retry and rerun-each flags

2 files. Category `d`. The flaky fixture stops after fail attempt 1 and the rerun fixture prints only Run #1. Scheduling the requested extra invocations is missing.

Test subject `--rerun-each should run tests exactly N times`. Throwing frame `at <anonymous> (/bun/test/cli/test/rerun-each.test.ts:37:18)`.

Observed diagnostic:

```text
Expected to contain: "Run #2"
Received: "bun test v1.4.4 (cd95fa7a1)\nRun #1\n"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2301](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2301). Reproducer `suite quickjs 'cli/test/rerun-each.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `cli/test/rerun-each.test.ts`
- `cli/test/retry-flag.test.ts`

</details>

<a id="cause-vm-module"></a>

### 85. vm.SourceTextModule is absent

2 files. Category `d`. The vm module exposes evaluation helpers without the source-module constructor and linking lifecycle required by these fixtures.

Test subject `vm.SourceTextModule > shouldn't leak memory`. Throwing frame `at go (/bun/test/js/node/vm/sourcetextmodule-leak.test.ts:21:27)`.

Observed diagnostic:

```text
const mod = new vm.SourceTextModule(source + "//" + i, {                                ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:293](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L293). Reproducer `suite quickjs 'js/node/vm/sourcetextmodule-leak.test.ts'`.

<details>
<summary>All 2 member files</summary>

- `js/node/vm/sourcetextmodule-leak.test.ts`
- `js/node/vm/sourcetextmodule-link-gc.test.ts`

</details>

<a id="cause-install-release-age"></a>

### 86. --minimum-release-age is rejected by the install parser

1 file. Category `c`. The first test invokes install --minimum-release-age followed by --no-verify. Neither option is in the parser, so it exits 1 before selecting an age-qualified version.

Test subject `minimum-release-age > basic filtering > filters packages by minimum release age`. Throwing frame `at <anonymous> (/bun/test/cli/install/minimum-release-age.test.ts:962:24)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/minimum-release-age.test.ts'`.

<a id="cause-no-addons-flag"></a>

### 87. --no-addons is rejected before the worker can report ERR_DLOPEN_DISABLED

1 file. Category `c`. The child has no expected stdout marker. The CLI has no no-addons option handling, so this is earlier than addon load policy in workers.

Test subject `--no-addons stays in effect inside a Worker with an empty execArgv`. Throwing frame `at <anonymous> (/bun/test/js/node/no-addons.test.ts:30:25)`.

Observed diagnostic:

```text
Expected: "ERR_DLOPEN_DISABLED"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:416](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L416). Reproducer `suite quickjs 'js/node/no-addons.test.ts'`.

<a id="cause-no-tests"></a>

### 88. --pass-with-no-tests does not change the empty-suite exit code

1 file. Category `c`. The runner always exits 1 when discovery returns no files, even with the pass-with-no-tests option.

Test subject `--pass-with-no-tests exits with 0 when no test files found`. Throwing frame `at <anonymous> (/bun/test/cli/test/pass-with-no-tests.test.ts:20:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2376](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2376). Reproducer `suite quickjs 'cli/test/pass-with-no-tests.test.ts'`.

<a id="cause-yarn-workspace"></a>

### 89. --yarn lockfile output and workspace protocol serialization are absent

1 file. Category `d`. The initial install exits 1 before a Yarn lockfile can quote workspace:* correctly. The install parser does not support --yarn.

Test subject `issue #3192 > yarn lockfile quotes workspace:* versions correctly`. Throwing frame `at <anonymous> (/bun/test/regression/issue/3192.test.ts:35:22)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'regression/issue/3192.test.ts'`.

<a id="cause-spawn-renamed-cwd"></a>

### 90. A renamed current directory is not preserved as a usable child cwd

1 file. Category `c`. All expected sync and async success markers are absent. Child startup reconstructs cwd from a pathname instead of retaining the current directory capability.

Test subject `spawn without explicit cwd works after the parent's cwd is renamed`. Throwing frame `at <anonymous> (/bun/test/js/bun/spawn/spawn-renamed-cwd.test.ts:50:33)`.

Observed diagnostic:

```text
- "sync-ok
- async-ok
- execFileSync-ok
+ ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:72](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L72). Reproducer `suite quickjs 'js/bun/spawn/spawn-renamed-cwd.test.ts'`.

<a id="cause-abort-any-validation"></a>

### 91. AbortSignal.any does not reject a non-AbortSignal iterator result

1 file. Category `c`. The adversarial iterator expected 256 TypeErrors and observes zero. Validate each yielded signal before registering listeners.

Test subject `AbortSignal > AbortSignal.any() rejects a non-AbortSignal element without allocating a dependent signal`. Throwing frame `at <anonymous> (/bun/test/js/web/abort/abort.test.ts:66:58)`.

Observed diagnostic:

```text
-   "threw": 256,
+   "threw": 0,
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:593](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L593). Reproducer `suite quickjs 'js/web/abort/abort.test.ts'`.

<a id="cause-install-add-header"></a>

### 92. Adding explicit packages reports install instead of add

1 file. Category `c`. The output begins bun install rather than bun add and lists bare plus entries rather than installed entries. Match the public command output before evaluating later override resolution differences.

Test subject `overrides affect your own packages`. Throwing frame `at <anonymous> (/bun/test/cli/install/overrides.test.ts:79:18)`.

Observed diagnostic:

```text
- "bun add <version> (<revision>)
- installed no-deps@1.0.0
- installed a-dep@1.0.10
+ "bun install v<bun-version> (cd95fa7a1)
+ + a-dep@1.0.10
+ + no-deps@2.0.0
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:71](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L71). Reproducer `suite quickjs 'cli/install/overrides.test.ts'`.

<a id="cause-runner-failure-hooks"></a>

### 93. afterAll hooks are skipped after a failing beforeAll

1 file. Category `c`. The hook log is beforeall1 instead of beforeall1,afterall1,afterall2. The scope returns immediately after beforeAll failure.

Test subject `failure-skip > beforeall1`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/failure-skip.test.ts:27:51)`.

Observed diagnostic:

```text
Expected: "beforeall1,afterall1,afterall2"
Received: "beforeall1"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:1946](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L1946). Reproducer `suite quickjs 'js/bun/test/failure-skip.test.ts'`.

<a id="cause-spawn-abort-code"></a>

### 94. Already-aborted spawn forwards signal.reason without Node's ABORT_ERR fields

1 file. Category `c`. The received AbortError has the right name and message but no code ABORT_ERR. The start function directly throws signal.reason.

Test subject `spawn AbortSignal throws if already aborted`. Throwing frame `at <anonymous> (/bun/test/js/bun/spawn/spawn-signal.test.ts:45:18)`.

Observed diagnostic:

```text
- ObjectContaining {
-   "code": "ABORT_ERR",
-   "name": "AbortError",
+ [AbortError: This operation was aborted]
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:85](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L85). Reproducer `suite quickjs 'js/bun/spawn/spawn-signal.test.ts'`.

<a id="cause-empty-text-loader"></a>

### 95. An empty imported text file returns an object instead of a string

1 file. Category `c`. The expected empty string becomes an empty object. Check extension-based text-loader selection and default export construction.

Test subject `importing empty text file returns empty string`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/import-empty.test.js:16:27)`.

Observed diagnostic:

```text
Expected: ""
Received: {}
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:407](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L407). Reproducer `suite quickjs 'js/bun/resolve/import-empty.test.js'`.

<a id="cause-install-empty-lock"></a>

### 96. An empty install writes a lockfile instead of deleting it

1 file. Category `c`. The fixture expects No packages! Deleted empty lockfile and receives Saved lockfile. This is empty dependency-set handling.

Test subject `hosted-git-info boundary conditions > shortcut with nothing after the colon > override values of all five providers`. Throwing frame `at <anonymous> (/bun/test/cli/install/hosted-git-info/boundary-conditions.test.ts:58:22)`.

Observed diagnostic:

```text
Expected to contain: "No packages! Deleted empty lockfile"
Received: "Saved lockfile\n"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:80](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L80). Reproducer `suite quickjs 'cli/install/hosted-git-info/boundary-conditions.test.ts'`.

<a id="cause-macro-promise"></a>

### 97. Async macro expansion emits a pending Promise instead of its resolved value

1 file. Category `d`. The child prints Promise { <pending> } instead of the SHA-256 base64url digest returned by the awaited macro. Inspect macro evaluation completion before printing or substitution.

Test subject `macro that awaits crypto.subtle.digest resolves under bun run`. Throwing frame `at <anonymous> (/bun/test/regression/issue/39900.test.ts:31:18)`.

Observed diagnostic:

```text
Expected to contain: "rX-sslhvxulmwATX0dFrAk9YBf98tHx6hdq9i0iJLKc\n"
Received: "Promise { <pending> }\n"
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:114](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L114). Reproducer `suite quickjs 'regression/issue/39900.test.ts'`.

<a id="cause-als-default"></a>

### 98. AsyncLocalStorage ignores its defaultValue option

1 file. Category `c`. After run restores the prior context, getStore returns undefined instead of the supplied default def.

Test subject `AsyncLocalStorage > run() works with a defaultValue and no prior context`. Throwing frame `at <anonymous> (/bun/test/js/node/async_hooks/AsyncLocalStorage.test.ts:22:26)`.

Observed diagnostic:

```text
Expected: "def"
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:344](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L344). Reproducer `suite quickjs 'js/node/async_hooks/AsyncLocalStorage.test.ts'`.

<a id="cause-buffer-resize"></a>

### 99. Buffer.from creates a fixed-length view over a resizable ArrayBuffer

1 file. Category `c`. fromArrayBuffer always passes an explicit length to FastBuffer. After the backing buffer shrinks, that fixed 1024-byte view becomes out of bounds and reports length zero. Bun expects a length-tracking Buffer with length ten when the caller omitted length; copy consequently returns zero instead of ten.

Test subject `Buffer.copy with detach / resize via valueOf > copy clamps to post-resize logical length when source is resized in sourceStart valueOf (OOB read repro)`. Throwing frame `at <anonymous> (/bun/test/js/node/buffer-copy-fill-detach.test.ts:105:32)`.

Observed diagnostic:

```text
-   "copied": 10,
-   "sourceLength": 10,
-   "t0": 171,
+   "copied": 0,
+   "sourceLength": 0,
+   "t0": 0,
```

Suspected implementation [crates/bunwasm-runtime/src/js/buffer.js:456](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/buffer.js#L456). Reproducer `suite quickjs 'js/node/buffer-copy-fill-detach.test.ts'`.

<a id="cause-check-command"></a>

### 100. bun check is absent

1 file. Category `d`. The typecheck command is rejected before producing diagnostics or ANSI colors. Empty colored stdout is a consequence of missing command dispatch.

Test subject `bun check > colors change nothing but the colors`. Throwing frame `at <anonymous> (/bun/test/cli/check/check.test.ts:159:28)`.

Observed diagnostic:

```text
Expected to contain: "\u001b["
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:403](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L403). Reproducer `suite quickjs 'cli/check/check.test.ts'`.

<a id="cause-create-init-command"></a>

### 101. bun create is absent

1 file. Category `d`. The project scaffolding command reaches the explicit unsupported-command arm and exits before creating its template.

Test subject `should not crash > ["create",""]`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-create.test.ts:41:24)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:400](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L400). Reproducer `suite quickjs 'cli/install/bun-create.test.ts'`.

<a id="cause-init-command"></a>

### 102. bun init is absent

1 file. Category `d`. The project initializer exits at CLI dispatch before generating any project files.

Test subject `bun init > bun init works`. Throwing frame `at <anonymous> (/bun/test/cli/init/init.test.ts:40:26)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:400](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L400). Reproducer `suite quickjs 'cli/init/init.test.ts'`.

<a id="cause-link-command"></a>

### 103. bun link is absent

1 file. Category `d`. The fixture's first child runs bun link and exits 1. CRLF normalization and executable bit checks are later assertions and have not been reached.

Test subject `bin linking normalizes CRLF in shebang`. Throwing frame `at <anonymous> (/bun/test/cli/install/shebang-normalize.test.ts:40:31)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:400](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L400). Reproducer `suite quickjs 'cli/install/shebang-normalize.test.ts'`.

<a id="cause-pm-fetch"></a>

### 104. bun pm fetch is absent

1 file. Category `d`. The pm dispatcher only implements ls. Fetch exits before populating the cache or printing the expected fetched-package summary.

Test subject `should fetch dependencies into the cache without installing`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-pm-fetch.test.ts:83:18)`.

Observed diagnostic:

```text
-
- "bun pm fetch <version> (<revision>)
-
+ ""
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:451](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L451). Reproducer `suite quickjs 'cli/install/bun-pm-fetch.test.ts'`.

<a id="cause-pm-optional-peer"></a>

### 105. bun pm ls fails on an unresolved optional peer entry

1 file. Category `c`. The first pm listing exits 1 rather than zero for an optional peer lacking a resolved package id. Inspect the lockfile traversal before output formatting.

Test subject `unresolved optional peers don't crash`. Throwing frame `at <anonymous> (/bun/test/regression/issue/24502/bun-pm-ls-all-invalid-package-id.test.ts:28:24)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L449). Reproducer `suite quickjs 'regression/issue/24502/bun-pm-ls-all-invalid-package-id.test.ts'`.

<a id="cause-pm-pkg"></a>

### 106. bun pm pkg is absent

1 file. Category `d`. Reading or updating package manifest fields is rejected with Only bun pm ls is supported in bun-wasm.

Test subject `bun pm pkg > get command > should get a single property`. Throwing frame `at runPmPkg (/bun/test/cli/install/bun-pm-pkg.test.ts:19:15)`.

Observed diagnostic:

```text
throw new Error(`Expected success but got code ${exitCode}. stderr: ${stderr}`);                    ^
error: Expected success but got code 1. stderr: error: Only bun pm ls is supported in bun-wasm
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:451](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L451). Reproducer `suite quickjs 'cli/install/bun-pm-pkg.test.ts'`.

<a id="cause-pm-version"></a>

### 107. bun pm version is absent

1 file. Category `d`. The version-management subcommand exits 1 before printing help or previewing package version changes.

Test subject `bun pm version > help and version previews > should show help when no arguments provided`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-pm-version.test.ts:129:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:451](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L451). Reproducer `suite quickjs 'cli/install/bun-pm-version.test.ts'`.

<a id="cause-publish-command"></a>

### 108. bun publish help is absent

1 file. Category `d`. The publishing command is rejected before producing its --dry-run help text. The fixture does not publish a package.

Test subject `bun publish --help shows correct message for --dry-run`. Throwing frame `at <anonymous> (/bun/test/regression/issue/24806.test.ts:16:18)`.

Observed diagnostic:

```text
Expected to contain: "--dry-run"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:401](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L401). Reproducer `suite quickjs 'regression/issue/24806.test.ts'`.

<a id="cause-repl-command"></a>

### 109. bun repl is absent

1 file. Category `d`. The REPL command is rejected before emitting the Welcome to Bun banner. This is independent of terminal input handling.

Test subject `issue #26058 - bun repl startup time > bun repl starts without downloading packages`. Throwing frame `at <anonymous> (/bun/test/regression/issue/26058.test.ts:36:20)`.

Observed diagnostic:

```text
Expected to contain: "Welcome to Bun"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:401](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L401). Reproducer `suite quickjs 'regression/issue/26058.test.ts'`.

<a id="cause-package-run-script"></a>

### 110. bun run does not resolve package.json script names

1 file. Category `d`. The go script is loaded as a module path and fails Module not found go. No child shell script runs, so the fixture has not reached SIGKILL propagation.

Test subject `bun run propagates SIGKILL from a child without hitting unreachable`. Throwing frame `at <anonymous> (/bun/test/cli/run/run-propagate-sigkill.test.ts:30:18)`.

Observed diagnostic:

```text
Expected to contain: "SIGKILL"
Received: "error: Module not found \"go\"\n\nBun v1.4.4 (WASI wasm32)\n"
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:408](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L408). Reproducer `suite quickjs 'cli/run/run-propagate-sigkill.test.ts'`.

<a id="cause-entry-directory"></a>

### 111. bun run opens a directory instead of resolving its package entry

1 file. Category `c`. The dot entry produces EIO opening the directory itself instead of honoring package.json main and running the entry file.

Test subject `bun run > bun > should work with . > respecting 'main' field and allowing trailing commas/comments in package.json`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-run.test.ts:39:26)`.

Observed diagnostic:

```text
- ""
+ "EIO: i/o error, open '/tmp/bun-run-main_8WCDkR'
+     path: "/tmp/bun-run-main_8WCDkR",
+  syscall: "open",
```

Suspected implementation [crates/bunwasm-runtime/src/lib.rs:321](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/lib.rs#L321). Reproducer `suite quickjs 'cli/install/bun-run.test.ts'`.

<a id="cause-fetch-verbose"></a>

### 112. BUN_CONFIG_VERBOSE_FETCH=curl produces no request trace

1 file. Category `c`. The request completes without the expected --data-raw command-line trace. Verbose-fetch logging is absent, not the form-urlencoded body itself.

Test subject `#12042 curl verbose fetch logs form-urlencoded body`. Throwing frame `at <anonymous> (/bun/test/regression/issue/12042.test.ts:46:22)`.

Observed diagnostic:

```text
Expected to contain: "--data-raw \"grant_type=client_credentials&client_id=abc&client_secret=xyz"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:150](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L150). Reproducer `suite quickjs 'regression/issue/12042.test.ts'`.

<a id="cause-bun-options"></a>

### 113. BUN_OPTIONS is not parsed before CLI dispatch

1 file. Category `c`. The environment-supplied eval option is ignored and the child prints usage instead of the success marker.

Test subject `BUN_OPTIONS environment variable > basic usage - passes options to bun command`. Throwing frame `at <anonymous> (/bun/test/cli/env/bun-options.test.ts:17:38)`.

Observed diagnostic:

```text
Expected to contain: "BUN_OPTIONS WAS A SUCCESS"
Received: "Bun is a fast JavaScript runtime. This is bun.wasm: Bun's runtime on WebAssembly (WASI).\n\nUsage: bun <command> [...flags] [...args]\n\nCommands:\n  run       ./my-script.ts       Execute a file with Bun\n  t
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:371](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L371). Reproducer `suite quickjs 'cli/env/bun-options.test.ts'`.

<a id="cause-emit-memory-pressure"></a>

### 114. bun:internal-for-testing.emitMemoryPressure is absent

1 file. Category `c`. The fixture explicitly injects warning and critical through a missing test helper and observes no process events. Synthetic injection can validate and emit those events without causing real OS memory pressure. No native capability or high-cost instrumentation requirement is established by this test.

Test subject `process.on('memoryPressure') > listener receives level argument`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-memory-pressure.test.ts:69:47)`.

Observed diagnostic:

```text
-   "stderr": "",
-   "stdout": "["warning","critical"]",
+   "stderr": "1 |
+ 2 |       const { emitMemoryPressure } = require("bun:internal-for-testing");
+ 3 |       const seen = [];
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:840](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L840). Reproducer `suite quickjs 'js/node/process/process-memory-pressure.test.ts'`.

<a id="cause-native-heap-snapshot"></a>

### 115. bun:jsc.generateHeapSnapshotForDebugging is absent

1 file. Category `e`. Collection fails on the missing private snapshot export. Retain e because producing the expected native heap graph would require instrumenting each collector and reproducing Bun/JSC cell, edge and root metadata. The Engine interface exposes no heap graph and browser workers have no standard heap-snapshot API. That private-format instrumentation cost is separate from implementing public ModuleGraph behavior.

Test subject `<collection>`. Throwing frame `collection or native failure; no JavaScript frame captured`.

Observed diagnostic:

```text
# Unhandled error between tests -------------------------------
SyntaxError: Could not find export 'generateHeapSnapshotForDebugging' in module 'bun:jsc'
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:813](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L813). Reproducer `suite quickjs 'js/bun/module-graph/module-graph-gc.test.ts'`.

<a id="cause-noinline"></a>

### 116. bun:jsc.noInline is absent

1 file. Category `e`. The raw child calls noInline before reading compilation counts. Retain e because JSC in wasm cannot JIT and QuickJS is an interpreter, while an unprivileged browser worker exposes neither no-inline controls nor DFG compile counts. Reproducing JSC tiering controls across those engines would fabricate a native compiler state rather than test Buffer behavior.

Test subject `Buffer accessor JIT > the JIT path is actually taken, and compile counts converge`. Throwing frame `at <anonymous> (/bun/test/js/node/buffer-jit.test.ts:62:20)`.

Observed diagnostic:

```text
- ""
+ " 6 | for (let i = 0; i < buf.length; i++) buf[i] = (i * 37 + 11) & 0xff;
+  7 | const N = 20000;
+  8 |
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:813](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L813). Reproducer `suite quickjs 'js/node/buffer-jit.test.ts'`.

<a id="cause-bun-main"></a>

### 117. bun:main is not a registered builtin module

1 file. Category `d`. Dynamic import of bun:main rejects as a missing module. The module wrapper cannot be returned because the builtin registry has no entry.

Test subject `dynamic import('bun:main') returns the wrapper module`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/bun-main-entry-point.test.ts:50:95)`.

Observed diagnostic:

```text
-   "exitCode": 0,
-   "stderr": [],
-   "stdout": "OK
+   "exitCode": 1,
+   "stderr": [
+     "Error: Cannot find module 'bun:main' from '/tmp/bun-main-dyn_3D0t6b/entry.mjs'",
```

Suspected implementation [crates/bunwasm-runtime/src/resolve.rs:44](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/resolve.rs#L44). Reproducer `suite quickjs 'js/bun/resolve/bun-main-entry-point.test.ts'`.

<a id="cause-skip-aliases"></a>

### 118. bun:test lacks xit, xtest and xdescribe aliases

1 file. Category `c`. The child exits 1 instead of running the skip aliases. The exports object contains test, it and describe without those aliases.

Test subject `xit, xtest, and xdescribe aliases should work as test.skip/describe.skip`. Throwing frame `at <anonymous> (/bun/test/regression/issue/5228.test.js:56:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2385](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2385). Reproducer `suite quickjs 'regression/issue/5228.test.js'`.

<a id="cause-macro-build"></a>

### 119. Bun.build called from a macro does not reach the expected rejection handler

1 file. Category `d`. The child prints no BUILD_SUCCESS marker. Inspect macro reentrancy and the async build return path rather than reducing this to stdout equality.

Test subject `Bun.build from macro during bundling throws instead of hanging`. Throwing frame `at <anonymous> (/bun/test/regression/issue/26360.test.ts:76:18)`.

Observed diagnostic:

```text
Expected to contain: "BUILD_SUCCESS"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:369](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L369). Reproducer `suite quickjs 'regression/issue/26360.test.ts'`.

<a id="cause-public-color"></a>

### 120. Bun.color is absent

1 file. Category `d`. The child calls public Bun.color and throws not a function. It never reaches color parsing or the nested atan2 complexity check. The Rust color/CSS implementation is portable; this is an API implementation gap, not a private-hook exclusion.

Test subject `deeply nested atan2() color values parse in linear time instead of hanging`. Throwing frame `at <anonymous> (/bun/test/js/bun/css/atan2-backtracking-hang.test.ts:50:18)`.

Observed diagnostic:

```text
- ""
+ "1 |
+ 2 |     const inputs = ["hsl(sin(2\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan2(9\n-(atan
+ 3 |     console.log(JSON.stringify(inputs.map(css => Bun.color(css, "css"))));
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/css/atan2-backtracking-hang.test.ts'`.

<a id="cause-deep-equals-arity"></a>

### 121. Bun.deepEquals accepts one argument instead of rejecting it

1 file. Category `c`. The child expects TypeError: Expected 2 values to compare and prints nothing. The wrapper forwards missing arguments without an arity check.

Test subject `Bun.deepEquals with one argument`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/exception-checks.test.ts:47:60)`.

Observed diagnostic:

```text
-   "stdout": "TypeError: Expected 2 values to compare",
+   "stdout": "",
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:473](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L473). Reproducer `suite quickjs 'js/bun/jsc/exception-checks.test.ts'`.

<a id="cause-deep-equals-fourth"></a>

### 122. Bun.deepEquals drops its fourth ignore-class-name argument

1 file. Category `c`. The wrapper forwards only three arguments. deepEquals(new Foo(),new Bar(),true,true) receives false where true is required.

Test subject `Bun.deepEquals strict mode > ignores class names when the fourth argument is true`. Throwing frame `at <anonymous> (/bun/test/js/bun/bun-object/deep-equals.test.ts:126:58)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:473](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L473). Reproducer `suite quickjs 'js/bun/bun-object/deep-equals.test.ts'`.

<a id="cause-deep-match"></a>

### 123. Bun.deepMatch passes the wrong partial-match semantics

1 file. Category `c`. The wrapper supplies a fourth argument to bunDeepEquals, which accepts only three. Partial object matching returns false instead of true.

Test subject `Bun.deepMatch > Bun.deepMatch({`. Throwing frame `at <anonymous> (/bun/test/js/bun/bun-object/deep-match.spec.ts:81:33)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:474](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L474). Reproducer `suite quickjs 'js/bun/bun-object/deep-match.spec.ts'`.

<a id="cause-escape-html-symbol"></a>

### 124. Bun.escapeHTML accepts Symbol instead of throwing

1 file. Category `c`. String coercion returns Symbol(Symbol.iterator) where implicit symbol-to-string conversion must throw TypeError.

Test subject `escapeHTML > coerces non-string arguments`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/escapeHTML.test.js:157:47)`.

Observed diagnostic:

```text
Expected substring: "Cannot convert a symbol to a string"
Received function did not throw
Received value: "Symbol(Symbol.iterator)"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:163](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L163). Reproducer `suite quickjs 'js/bun/util/escapeHTML.test.js'`.

<a id="cause-escape-regexp"></a>

### 125. Bun.escapeRegExp is absent

1 file. Category `c`. The named import resolves to an undefined property of Bun and throws on the first call.

Test subject `escapeRegExp`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/escapeRegExp.test.ts:7:10)`.

Observed diagnostic:

```text
expect(escapeRegExp("\\ ^ $ * + ? . ( ) | { } [ ]")).toBe("\\\\ \\^ \\$ \\* \\+ \\? \\. \\( \\) \\| \\{ \\} \\[ \\]");              ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/util/escapeRegExp.test.ts'`.

<a id="cause-file-mime"></a>

### 126. Bun.file appends charset to an explicitly supplied MIME type

1 file. Category `c`. The expected text/markdown becomes text/markdown;charset=utf-8. Preserve the caller's explicit type.

Test subject `util file tests > custom set mime-type respected (#6507)`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/file-type.test.ts:7:23)`.

Observed diagnostic:

```text
Expected: "text/markdown"
Received: "text/markdown;charset=utf-8"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:128](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L128). Reproducer `suite quickjs 'js/bun/util/file-type.test.ts'`.

<a id="cause-async-stack-wording"></a>

### 127. Bun.file rejection stacks omit async frame markers

1 file. Category `c`. The stack contains level2 and level1 but not at async level2. The filesystem operation and ENOENT code occur; the first remaining mismatch is stack presentation.

Test subject `Bun.file() read errors include async stack frames`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/bun-file.test.ts:61:24)`.

Observed diagnostic:

```text
Expected to contain: "at async level2"
Received: "    at _bytes (bun-wasm:bun:57:66)\n    at text (bun-wasm:bun:82:37)\n    at level2 (/bun/test/js/bun/util/bun-file.test.ts:46:60)\n    at level1 (/bun/test/js/bun/util/bun-file.test.ts:49:11)\n    at <anonymo
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:57](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L57). Reproducer `suite quickjs 'js/bun/util/bun-file.test.ts'`.

<a id="cause-bun-file-exists-dir"></a>

### 128. Bun.file.exists reports directories as existing files

1 file. Category `c`. The directory path returns true where Bun.file.exists expects false. Inspect the file-type check rather than filesystem path existence alone.

Test subject `bun-file-exists`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/bun-file-exists.test.js:10:52)`.

Observed diagnostic:

```text
Received: true
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:88](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L88). Reproducer `suite quickjs 'js/bun/util/bun-file-exists.test.js'`.

<a id="cause-highlighter"></a>

### 129. Bun.highlighter is absent

1 file. Category `c`. The named import is not callable. The highlighted output and ANSI length have not been evaluated.

Test subject `highlighter`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/highlighter.test.ts:8:10)`.

Observed diagnostic:

```text
expect(highlighter("`can do ${123} ${'123'} ${`123`}`").length).toBeLessThan(150);              ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/util/highlighter.test.ts'`.

<a id="cause-inspect-build-error"></a>

### 130. Bun.inspect leaks internal BuildError formatting properties

1 file. Category `c`. The snapshot receives BuildError and its enumerable __bunwasmFormatted string instead of Bun's rendered code-frame diagnostic. Hide internal formatting metadata and use the public error formatter.

Test subject `BuildMessage`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/inspect-error.test.js:63:7)`.

Observed diagnostic:

```text
- "2 | const duplicateConstDecl = 456;
-           ^
- error: "duplicateConstDecl" has already been declared
+ "BuildError: "duplicateConstDecl" has already been declared
+  __bunwasmFormatted: "2 | const duplicateConstDecl = 456;/n          ^/nerror: /"duplicateConstDecl/" has already been declared/n    at [dir]/inspect-error-fixture-bad.js:2:7/n/n",
+ "
```

Suspected implementation [crates/bunwasm-runtime/src/js/inspect.js:206](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/inspect.js#L206). Reproducer `suite quickjs 'js/bun/util/inspect-error.test.js'`.

<a id="cause-open-editor"></a>

### 131. Bun.openInEditor cannot launch an external editor

1 file. Category `b`. The fake editor records no code or subl invocation. External executable spawning is unavailable, so the fixture has not measured editor argument lifetime.

Test subject `Bun.openInEditor finds the editor's binary on PATH`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/open-in-editor-gc.test.ts:47:44)`.

Observed diagnostic:

```text
-   "code --goto src/app.ts:3:7",
-   "subl src/app.ts",
+   "",
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:521](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L521). Reproducer `suite quickjs 'js/bun/util/open-in-editor-gc.test.ts'`.

<a id="cause-plugin-loader"></a>

### 132. Bun.plugin and its runtime build.module registry are absent

1 file. Category `d`. The child calls Bun.plugin before registering its virtual TypeScript module. The public Bun object has no plugin function. Loader-specific parsing has not yet been reached.

Test subject `issue #12548: TypeScript syntax should work with 'ts' loader in BunPlugin`. Throwing frame `at <anonymous> (/bun/test/regression/issue/12548.test.ts:36:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'regression/issue/12548.test.ts'`.

<a id="cause-uuid5"></a>

### 133. Bun.randomUUIDv5 is absent

1 file. Category `c`. The first deterministic namespace UUID calculation calls an absent API.

Test subject `randomUUIDv5 > basic functionality`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/randomUUIDv5.test.ts:9:24)`.

Observed diagnostic:

```text
const result = Bun.randomUUIDv5("www.example.com", dnsNamespace);                            ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/util/randomUUIDv5.test.ts'`.

<a id="cause-secrets-validation"></a>

### 134. Bun.secrets is absent, so argument errors have no Bun code

1 file. Category `c`. The NUL argument test catches a TypeError from calling the absent API, with code undefined rather than ERR_INVALID_ARG_VALUE.

Test subject `Bun.secrets argument validation > rejects service, name, and value strings containing a null byte`. Throwing frame `at <anonymous> (/bun/test/js/bun/secrets-error-codes.test.ts:24:27)`.

Observed diagnostic:

```text
Expected: "ERR_INVALID_ARG_VALUE"
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'js/bun/secrets-error-codes.test.ts'`.

<a id="cause-null-argument-wording"></a>

### 135. Bun.spawn NUL validation uses a different public message

1 file. Category `c`. The call correctly rejects a NUL argument but says Command arguments cannot contain null bytes instead of matching must be a string without null bytes. Match this argument-validation diagnostic.

Test subject `null byte injection protection > Bun.spawn > throws error when command contains null byte`. Throwing frame `at <anonymous> (/bun/test/js/bun/spawn/null-byte-injection.test.ts:10:10)`.

Observed diagnostic:

```text
Expected pattern: /must be a string without null bytes/
Received message: "Command arguments cannot contain null bytes"
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:42](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L42). Reproducer `suite quickjs 'js/bun/spawn/null-byte-injection.test.ts'`.

<a id="cause-file-stdin-slice"></a>

### 136. Bun.stdin.slice applies an offset that Bun ignores for stream stdin

1 file. Category `c`. The first byte is removed, yielding ello world instead of hello world. Investigate descriptor-backed stream slicing separately from ordinary file slicing.

Test subject `Bun.stdin.slice(1).text() does not crash when stdin is a pipe`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/bun-stdin-slice.test.ts:22:18)`.

Observed diagnostic:

```text
Expected: "hello world"
Received: "ello world"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:506](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L506). Reproducer `suite quickjs 'js/bun/util/bun-stdin-slice.test.ts'`.

<a id="cause-strip-ansi"></a>

### 137. Bun.stripANSI does not consume a complete OSC title sequence

1 file. Category `c`. ESC ] 0 ; window title BEL text leaves ;window title followed by BEL and text instead of text. The CSI-oriented regex is insufficient for OSC.

Test subject `Bun.stripANSI > "\u001b]0;window title\u0007text"`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/stripANSI.test.ts:478:98)`.

Observed diagnostic:

```text
Expected: "text"
Received: ";window titletext"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:172](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L172). Reproducer `suite quickjs 'js/bun/util/stripANSI.test.ts'`.

<a id="cause-bun-write-mode"></a>

### 138. Bun.write drops the requested filesystem mode

1 file. Category `c`. Copy mode is 420 decimal, or 0644, instead of the requested 384 decimal, or 0600. Forward the mode option to file creation.

Test subject `Bun.write() mode option > Bun.write() respects mode option when copying files via Bun.file()`. Throwing frame `at <anonymous> (/bun/test/regression/issue/25903.test.ts:28:35)`.

Observed diagnostic:

```text
Expected: 384
Received: 420
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:135](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L135). Reproducer `suite quickjs 'regression/issue/25903.test.ts'`.

<a id="cause-bunfig-validation"></a>

### 139. bunfig runtime option types are not validated

1 file. Category `c`. A string-valued smol config does not produce expected boolean but received string. The CLI startup path has no corresponding bunfig validation stage.

Test subject `bunfig.toml type-mismatch error messages > smol = "yes" -> expected boolean but received string`. Throwing frame `at <anonymous> (/bun/test/config/bunfig/bunfig-errors.test.ts:29:23)`.

Observed diagnostic:

```text
Expected: "error: expected boolean but received string"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:371](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L371). Reproducer `suite quickjs 'config/bunfig/bunfig-errors.test.ts'`.

<a id="cause-child-instance-spawn"></a>

### 140. ChildProcess instances have no spawn method

1 file. Category `c`. The function-level child_process wrappers do not supply the constructor instance method exercised by this file.

Test subject `ChildProcess.spawn() > should emit 'spawn' on spawn`. Throwing frame `at <anonymous> (/bun/test/js/node/child_process/child_process.test.ts:71:12)`.

Observed diagnostic:

```text
proc.spawn({ file: bunExe(), args: [bunExe(), "-v"] });                 ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:364](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L364). Reproducer `suite quickjs 'js/node/child_process/child_process.test.ts'`.

<a id="cause-http-setheaders"></a>

### 141. ClientRequest.setHeaders is absent

1 file. Category `c`. The request wrapper has no bulk Headers setter. No ERR_HTTP_HEADERS_SENT check is reached.

Test subject `ClientRequest.setHeaders should not throw ERR_HTTP_HEADERS_SENT on new request`. Throwing frame `at <anonymous> (/bun/test/regression/issue/27049.test.ts:25:7)`.

Observed diagnostic:

```text
req.setHeaders(new Headers({ "x-test": "value" }));            ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:1242](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L1242). Reproducer `suite quickjs 'regression/issue/27049.test.ts'`.

<a id="cause-require-extensions"></a>

### 142. CommonJS loading ignores user overrides of Module._extensions

1 file. Category `c`. The file executes with its built-in loader, but the .js loader called marker is absent. The source suffix still determines parsing; the user registry is bypassed.

Test subject `Module._extensions override should preserve loader type for each extension`. Throwing frame `at <anonymous> (/bun/test/regression/issue/require-extensions-override.test.ts:178:18)`.

Observed diagnostic:

```text
Expected to contain: ".js loader called"
Received: "plain.js loaded: javascript\ntyped.ts loaded: typescript\ndata.json loaded: json\ntypescript-in-js.js correctly failed\n"
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:1](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L1). Reproducer `suite quickjs 'regression/issue/require-extensions-override.test.ts'`.

<a id="cause-console-iterator"></a>

### 143. console has no async line iterator

1 file. Category `d`. The child executes for-await over console and produces no input lines. Console.write exists, but the Bun console async iterator is absent.

Test subject `should work for static input > hello world`. Throwing frame `at <anonymous> (/bun/test/js/bun/console/console-iterator.test.ts:24:33)`.

Observed diagnostic:

```text
Expected: "hello world"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/console.js:35](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/console.js#L35). Reproducer `suite quickjs 'js/bun/console/console-iterator.test.ts'`.

<a id="cause-console-time-stream"></a>

### 144. console.timeEnd writes to stdout instead of Bun's stderr

1 file. Category `c`. The expected stdout is empty, but it contains a duration and trailing newline. The first mismatch is output stream selection, not an extra newline.

Test subject `console.timeEnd with empty label emits exactly one trailing newline`. Throwing frame `at <anonymous> (/bun/test/js/web/console/console-timeLog.test.ts:14:18)`.

Observed diagnostic:

```text
- ""
+ "[0.00ms]
+ "
```

Suspected implementation [crates/bunwasm-runtime/src/js/console.js:86](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/console.js#L86). Reproducer `suite quickjs 'js/web/console/console-timeLog.test.ts'`.

<a id="cause-shake256"></a>

### 145. crypto.createHash does not support SHAKE256 outputLength

1 file. Category `c`. The leak fixture rejects createHash shake256 with Digest method not supported before making any deflate call. Add the digest capability before interpreting the file as a zlib memory failure.

Test subject `zlib compression does not leak memory > deflate`. Throwing frame `at <anonymous> (/bun/test/js/node/zlib/leak.test.ts:79:22)`.

Observed diagnostic:

```text
- ""
+ "21 | // 50,000 bytes of SHAKE256 output: the same bytes in every run, and they do not
+ 22 | // compress. So the output is as large as the input, and a retained output
+ 23 | // costs as much as a retained input. The output also fills four of the 16 KB
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:70](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L70). Reproducer `suite quickjs 'js/node/zlib/leak.test.ts'`.

<a id="cause-jwt-key-classification"></a>

### 146. crypto.createPublicKey rejects certificate PEMs

1 file. Category `c`. The fixture file named pub.pem contains a BEGIN CERTIFICATE block. readPem accepts only private/public key blocks, so createPublicKey throws Invalid PEM key. jsonwebtoken catches that failure and treats the certificate bytes as a symmetric key, allowing HS256 instead of rejecting invalid algorithm. A direct guest probe confirmed ERR_INVALID_ARG_TYPE:Invalid PEM key.

Test subject `when setting a wrong 'header.alg' > signing with pub key as symmetric > should not verify`. Throwing frame `at <anonymous> (/bun/test/js/third_party/jsonwebtoken/wrong_alg.test.js:19:10)`.

Observed diagnostic:

```text
Expected pattern: /invalid algorithm/
Received function did not throw
Received value: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/crypto_keys.js:309](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/crypto_keys.js#L309). Reproducer `suite quickjs 'js/third_party/jsonwebtoken/wrong_alg.test.js'`.

<a id="cause-css-default"></a>

### 147. CSS module imports return source text instead of an empty object

1 file. Category `c`. The default import is the CSS source string. Bun's runtime CSS loader contract returns an object for side-effect imports.

Test subject `css loader default export > bun run`. Throwing frame `at <anonymous> (/bun/test/js/bun/css/css-loader.test.ts:22:20)`.

Observed diagnostic:

```text
Expected: "object {}"
Received: "string ".c { color: red }""
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:407](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L407). Reproducer `suite quickjs 'js/bun/css/css-loader.test.ts'`.

<a id="cause-diagnostic-channel"></a>

### 148. diagnostics_channel.channel accepts null names

1 file. Category `c`. channel(null) returns normally instead of throwing for a name that is neither string nor symbol.

Test subject `Channel > can have symbol as name`. Throwing frame `at <anonymous> (/bun/test/js/node/diagnostics_channel/diagnostics_channel.test.ts:43:8)`.

Observed diagnostic:

```text
Expected pattern: /"channel" argument must be of type string or symbol/
Received function did not throw
Received value: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:433](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L433). Reproducer `suite quickjs 'js/node/diagnostics_channel/diagnostics_channel.test.ts'`.

<a id="cause-domexception-name"></a>

### 149. DOMException does not accept Bun's name-and-cause options object

1 file. Category `c`. The constructor stringifies the options object into [object Object] instead of setting name to CauseError.

Test subject `DOMException in Node.js environment > creates instance with options object`. Throwing frame `at <anonymous> (/bun/test/js/node/domexception-node.test.js:27:24)`.

Observed diagnostic:

```text
Expected: "CauseError"
Received: "[object Object]"
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:17](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L17). Reproducer `suite quickjs 'js/node/domexception-node.test.js'`.

<a id="cause-runner-reporters"></a>

### 150. Dots and only-failures reporters are not implemented

1 file. Category `d`. The runner prints passing status lines instead of dots or suppressed passing tests. This is reporter selection, not snapshot whitespace.

Test subject `dots 1`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/dots.test.ts:18:6)`.

Observed diagnostic:

```text
- "....................
-
- test/js/bun/test/dots.fixture.ts:
+ "js<cwd>/dots.fixture.ts:
+ (pass) passing filterin
+ (pass) passing filterin
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2301](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2301). Reproducer `suite quickjs 'js/bun/test/dots.test.ts'`.

<a id="cause-tla-cycle"></a>

### 151. Dynamic import in a top-level-await cycle exits before its continuation

1 file. Category `d`. The child exits without chunk loaded:43. Inspect module evaluation completion and lifecycle for the cycle instead of attributing empty stdout to console output.

Test subject `dynamic import inside TLA whose target imports the awaiter back does not deadlock`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/dynamic-import-tla-cycle.test.ts:36:25)`.

Observed diagnostic:

```text
Expected: "chunk loaded: 43"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:407](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L407). Reproducer `suite quickjs 'js/bun/resolve/dynamic-import-tla-cycle.test.ts'`.

<a id="cause-f-p521"></a>

### 152. Embedded crypto key generation rejects P-521

1 file. Category `f`. ECDSA and ECDH P-521 generation reject with Crypto generate failed before exported JWK widths can be tested. Browser fully passes. This is the embedded key backend, not proof of malformed export padding.

Test subject `ECDSA exported JWK fields have correct length`. Throwing frame `at <anonymous> (/bun/test/regression/issue/24399.test.ts:13:50)`.

Observed diagnostic:

```text
const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign"]);                                                       ^
NotSupportedError: Crypto generate failed
```

Suspected implementation [crates/bunwasm-runtime/src/js/crypto.js:476](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/crypto.js#L476). Reproducer `suite quickjs 'regression/issue/24399.test.ts'`.

<a id="cause-f-stream-class-name"></a>

### 153. Embedded Web Streams expose minified constructor names

1 file. Category `f`. ByteLengthQueuingStrategy inspects as class xe instead of its public class name. Browser fully passes with native streams. Match public constructor names when loading the embedded polyfill.

Test subject `node:stream/web classes inspect as [class X], not [class Function]`. Throwing frame `at <anonymous> (/bun/test/regression/issue/29225.test.ts:59:22)`.

Observed diagnostic:

```text
Expected: "ByteLengthQueuingStrategy: [class ByteLengthQueuingStrategy]"
Received: "ByteLengthQueuingStrategy: [class xe]"
```

Suspected implementation [crates/bunwasm-runtime/src/js/streams.js:7](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/streams.js#L7). Reproducer `suite quickjs 'regression/issue/29225.test.ts'`.

<a id="cause-f-jwk-octets"></a>

### 154. Embedded WebCrypto rejects a valid noncanonical JWK oct encoding

1 file. Category `f`. importKey rejects with Invalid JWK octets in the base64url fixture. Browser fully passes. Inspect the explicit octets validation in the embedded crypto implementation.

Test subject `testSecretJwkBase64Url`. Throwing frame `at roundTripSecretJwk (/bun/test/js/deno/crypto/webcrypto.test.ts:2409:37)`.

Observed diagnostic:

```text
const key = await crypto.subtle.importKey("jwk", jwk, algId, true, ops);                                            ^
DataError: Invalid JWK octets
```

Suspected implementation [crates/bunwasm-runtime/src/js/crypto.js:264](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/crypto.js#L264). Reproducer `suite quickjs 'js/deno/crypto/webcrypto.test.ts'`.

<a id="cause-f-x25519-bits"></a>

### 155. Embedded WebCrypto rejects X25519 deriveBits lengths that are not byte-aligned

1 file. Category `f`. Lengths 3 and 251 should mask unused trailing bits. The implementation rejects with Derived length must be a multiple of eight. Browser fully passes. A second assertion also exposes a usage-error wording mismatch.

Test subject `X25519 deriveBits zeroes the unused trailing bits of the last byte`. Throwing frame `at <anonymous> (/bun/test/js/bun/crypto/x25519-derive-bits.test.ts:76:19)`.

Observed diagnostic:

```text
crypto.subtle.deriveBits(alg, privateKey, 3),                        ^
OperationError: Derived length must be a multiple of eight
```

Suspected implementation [crates/bunwasm-runtime/src/js/crypto.js:448](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/crypto.js#L448). Reproducer `suite quickjs 'js/bun/crypto/x25519-derive-bits.test.ts'`.

<a id="cause-f-require-microtasks"></a>

### 156. Embedded-engine require of ESM pumps user microtasks too early

1 file. Category `f`. The then and await callbacks precede after-require. Browser fully passes. Inspect synchronous ESM evaluation and pending-job draining in the embedded-engine loader.

Test subject `require(esm) does not run user 'await' continuations ahead of earlier microtasks`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/require-esm-microtask-order.test.ts:42:37)`.

Observed diagnostic:

```text
-   "after-require",
+   "after-require",
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:407](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L407). Reproducer `suite quickjs 'js/bun/resolve/require-esm-microtask-order.test.ts'`.

<a id="cause-prepare-stack"></a>

### 157. Error.prepareStackTrace has no default callable implementation

1 file. Category `c`. The crash regression directly invokes the absent default function with a non-array second argument.

Test subject `Error.prepareStackTrace should not crash when stacktrace parameter is not an array`. Throwing frame `at <anonymous> (/bun/test/regression/issue/prepare-stack-trace-crash.test.ts:24:26)`.

Observed diagnostic:

```text
const result = Error.prepareStackTrace(e, "not an array");                               ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/stack_trace.js:57](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/stack_trace.js#L57). Reproducer `suite quickjs 'regression/issue/prepare-stack-trace-crash.test.ts'`.

<a id="cause-stacktrace-limit"></a>

### 158. Error.stackTraceLimit does not expose Bun's default property descriptor

1 file. Category `c`. The Error constructor descriptor value is undefined instead of 10. Inspect installation of the public stack-limit property, not assertion equality.

Test subject `WebKit 7b485a76e9 upgrade > Error.stackTraceLimit is read from the Error constructor when a stack is captured (a5bfdb3aaf)`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/webkit-upgrade-7b485a76e9.test.ts:31:32)`.

Observed diagnostic:

```text
Expected: 10
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/stack_trace.js:57](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/stack_trace.js#L57). Reproducer `suite quickjs 'js/bun/jsc/webkit-upgrade-7b485a76e9.test.ts'`.

<a id="cause-raw-js-parser"></a>

### 159. Eval skips Bun's dead-branch destructuring-var lowering

1 file. Category `d`. QuickJS receives if(0)var[] and rejects it as variable name expected. Native Bun first lowers this dead declaration away. Inspect eval loader selection and transpilation before changing the engine parser.

Test subject `'if(0)var[]' does not crash the printer (dead-branch destructuring var with no bindings)`. Throwing frame `at <anonymous> (/bun/test/regression/issue/31002.test.ts:48:18)`.

Observed diagnostic:

```text
- ""
+ "1 | if(0)var[]
+             ^
+ SyntaxError: variable name expected
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:414](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L414). Reproducer `suite quickjs 'regression/issue/31002.test.ts'`.

<a id="cause-eval-parser-diagnostic"></a>

### 160. Eval uses engine syntax diagnostics instead of Bun parser diagnostics

1 file. Category `d`. The child rejects the malformed source with QuickJS Unexpected token instead of the expected Bun parser message. The eval entry is registered as source directly. No host capability prevents using the already compiled Bun parser, so this is eval parsing and diagnostic integration work.

Test subject `'static { ... }' in an object-literal position ([{static{}) is a syntax error, not a parser crash`. Throwing frame `at <anonymous> (/bun/test/regression/issue/30963.test.ts:47:20)`.

Observed diagnostic:

```text
Expected to contain: "Expected \"}\" but found \"{\""
Received: "1 | [{static{}\n            ^\nSyntaxError: Unexpected token '{'\n      at <anonymous> (/bun/test/[eval]:1:9)\n\nBun v1.4.4 (WASI wasm32)\n"
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:414](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L414). Reproducer `suite quickjs 'regression/issue/30963.test.ts'`.

<a id="cause-event-once-constructor"></a>

### 161. EventEmitter.once is a normal function instead of an AsyncFunction

1 file. Category `c`. The result may be a Promise, but constructor.name is Function rather than AsyncFunction. The fixture tests the function's observable identity.

Test subject `node:events > once is an async function`. Throwing frame `at <anonymous> (/bun/test/js/node/events/event-emitter.test.ts:80:48)`.

Observed diagnostic:

```text
Expected: "AsyncFunction"
Received: "Function"
```

Suspected implementation [crates/bunwasm-runtime/src/js/events.js:209](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/events.js#L209). Reproducer `suite quickjs 'js/node/events/event-emitter.test.ts'`.

<a id="cause-array-size"></a>

### 162. expect.toBeArrayOfSize is absent

1 file. Category `c`. The assertion calls a missing matcher. Inspect the child result separately after this bounded test-runner gap is fixed.

Test subject `WebKit 6b879687ee upgrade > a destructuring pattern nested too deep does not crash bytecode generation (752ab90072)`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/webkit-upgrade-6b879687ee.test.ts:60:21)`.

Observed diagnostic:

```text
expect(results).toBeArrayOfSize(5);                          ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:851](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L851). Reproducer `suite quickjs 'js/bun/jsc/webkit-upgrade-6b879687ee.test.ts'`.

<a id="cause-unreachable-message"></a>

### 163. expect.unreachable stringifies Error instead of preserving its message

1 file. Category `c`. The assertion expects message here and receives Error: message here. Match Bun's public assertion diagnostic.

Test subject `expect.unreachable()`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/expect-unreaachable.test.ts:8:43)`.

Observed diagnostic:

```text
Expected message: "message here"
Received message: "Error: message here"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:780](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L780). Reproducer `suite quickjs 'js/bun/test/expect-unreaachable.test.ts'`.

<a id="cause-fetch-refused-code"></a>

### 164. Fetch exposes the host backend's ConnectionRefused code

1 file. Category `c`. The expected ECONNREFUSED becomes ConnectionRefused, and the message omits the ECONNREFUSED prefix. Match the public Node/Bun error contract at the host boundary.

Test subject `native error name/code preservation > fetch connection-refused message is preserved verbatim`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/error-name-preservation.test.ts:50:62)`.

Observed diagnostic:

```text
-   "code": "ECONNREFUSED",
-   "message": "ECONNREFUSED: Unable to connect. Is the computer able to access the url?",
+   "code": "ConnectionRefused",
+   "message": "Unable to connect. Is the computer able to access the url?",
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:150](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L150). Reproducer `suite quickjs 'js/bun/util/error-name-preservation.test.ts'`.

<a id="cause-mtime-write"></a>

### 165. Filesystem timestamps do not preserve the requested utimes values

1 file. Category `c`. The fixture stamps early outputs with utimesSync, but this wrapper only calls statSync and never updates timestamps. The early-output list therefore remains empty. The failure is filesystem timestamp mutation, not build graph analysis.

Test subject `loadBuild > finds when a command released an output early from the output's mtime`. Throwing frame `at <anonymous> (/bun/test/internal/build-timings.test.ts:247:55)`.

Observed diagnostic:

```text
- [
-   [
-     "rustc a",
+ []
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:619](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L619). Reproducer `suite quickjs 'internal/build-timings.test.ts'`.

<a id="cause-dirent-unknown"></a>

### 166. fs.constants lacks UV_DIRENT_UNKNOWN and UV_DIRENT_FIFO

1 file. Category `c`. The first assertion reads fs.constants.UV_DIRENT_UNKNOWN and receives undefined instead of zero. The fixture has not yet constructed a Dirent or exercised its type predicates.

Test subject `Dirent with unknown type should return false for all type checks`. Throwing frame `at <anonymous> (/bun/test/regression/issue/24129.test.ts:11:29)`.

Observed diagnostic:

```text
Expected: 0
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:9](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L9). Reproducer `suite quickjs 'regression/issue/24129.test.ts'`.

<a id="cause-mkdir-validation"></a>

### 167. fs.mkdir callback adapter defers invalid path errors

1 file. Category `c`. Invalid argument types should throw before the callback is scheduled. The adapter returns undefined without a synchronous TypeError.

Test subject `fs.mkdir > throws for invalid path types`. Throwing frame `at <anonymous> (/bun/test/js/node/fs/fs-mkdir.test.ts:82:53)`.

Observed diagnostic:

```text
Expected constructor: TypeError
Received function did not throw
Received value: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:658](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L658). Reproducer `suite quickjs 'js/node/fs/fs-mkdir.test.ts'`.

<a id="cause-fs-readstream-close"></a>

### 168. fs.ReadStream has no close method

1 file. Category `c`. The cleanup call rs.close throws. This is not evidence that O_CLOEXEC flags were measured successfully on WASI descriptors.

Test subject `node:fs opens set O_CLOEXEC > fs.createReadStream and fs.createWriteStream`. Throwing frame `at <anonymous> (/bun/test/js/node/fs/fs-open-cloexec.test.ts:71:10)`.

Observed diagnostic:

```text
rs.close();               ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:758](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L758). Reproducer `suite quickjs 'js/node/fs/fs-open-cloexec.test.ts'`.

<a id="cause-procfs-descriptors"></a>

### 169. Guest /proc/self/fd is not the native process descriptor table

1 file. Category `a`. The raw child fails with ENOENT scanning /proc/self/fd before touching poll registration. The runner preopens only its suite and temporary directories. The guest descriptor table is distinct from the launcher's native descriptor table, and no ABI operation exposes that table or native fcntl/poll handles. Adding a directory path alone would not make native fd numbers become guest handles.

Test subject `FilePoll teardown tolerates an fd closed while still registered`. Throwing frame `at <anonymous> (/bun/test/js/bun/spawn/spawn-pipe-stale-fd-unregister.test.ts:103:23)`.

Observed diagnostic:

```text
- []
+ [
+   "2 | import { closeSync, constants, fstatSync, openSync, readdirSync } from "node:fs";",
+   "3 | ",
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:374](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L374). Reproducer `suite quickjs 'js/bun/spawn/spawn-pipe-stale-fd-unregister.test.ts'`.

<a id="cause-immediate-id"></a>

### 170. Immediate handles do not coerce to increasing numeric identifiers

1 file. Category `c`. The id > lastID check is false because Immediate has no numeric id or Symbol.toPrimitive. It is a handle-coercion gap, not callback ordering.

Test subject `setImmediate`. Throwing frame `at <anonymous> (/bun/test/js/web/timers/setImmediate.test.js:23:27)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/bootstrap.js:337](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L337). Reproducer `suite quickjs 'js/web/timers/setImmediate.test.js'`.

<a id="cause-install-patch-progress"></a>

### 171. Install progress output omits resolving and migration status

1 file. Category `c`. The first snapshot expects Resolving dependencies followed by Saved lockfile. It receives only Saved lockfile. This first mismatch is cosmetic and should match; it does not prove patch application works.

Test subject `patch > should patch a dependency when its dependencies are not hoisted`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-install-patch.test.ts:155:42)`.

Observed diagnostic:

```text
-
- "Resolving dependencies
- Saved lockfile"
+ "Saved lockfile"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:80](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L80). Reproducer `suite quickjs 'cli/install/bun-install-patch.test.ts'`.

<a id="cause-install-lifecycle"></a>

### 172. Installer does not execute package lifecycle scripts

1 file. Category `d`. The marker indicating the lifecycle script ran is false. The install option parser ignores script controls and the installer has no lifecycle execution stage.

Test subject `lifecycle script should handle directory deletion gracefully`. Throwing frame `at <anonymous> (/bun/test/regression/issue/14945-lifecycle-script-crash.test.ts:40:116)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:40](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L40). Reproducer `suite quickjs 'regression/issue/14945-lifecycle-script-crash.test.ts'`.

<a id="cause-install-filter"></a>

### 173. Installer does not parse --filter workspace selection

1 file. Category `c`. The first add command exits with Unknown install option --filter instead of changing the selected workspace. Parsing is the first blocker; workspace-targeted resolution is later work.

Test subject `add --filter targets one workspace by name (and does not install an npm package called "api")`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-add-filter.test.ts:188:20)`.

Observed diagnostic:

```text
- "Saved lockfile
+ "error: Unknown install option: --filter
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/bun-add-filter.test.ts'`.

<a id="cause-package-extensions"></a>

### 174. Installer ignores packageExtensions metadata

1 file. Category `d`. The installed package manifest has no injected dependencies object. packageExtensions are not merged into metadata before dependency traversal.

Test subject `packageExtensions (hoisted) > adds a dependency, which bun.lock reproduces`. Throwing frame `at <anonymous> (/bun/test/cli/install/bun-install-package-extensions.test.ts:102:38)`.

Observed diagnostic:

```text
- {
-   "dependencies": {
-     "no-deps": "^1.0.0",
+ {}
```

Suspected implementation [crates/bunwasm-runtime/src/install/resolve.rs:89](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/resolve.rs#L89). Reproducer `suite quickjs 'cli/install/bun-install-package-extensions.test.ts'`.

<a id="cause-install-destination"></a>

### 175. Installer rejects --destination before workspace migration

1 file. Category `c`. The complex-workspace setup command exits at flag parsing rather than migrating its dependency graph.

Test subject `(unnamed)`. Throwing frame `at pack (/bun/test/harness.ts:1766:19)`.

Observed diagnostic:

```text
Expected to not contain: "error:"
Received: "error: Unknown install option: --destination\n"
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/migration/complex-workspace.test.ts'`.

<a id="cause-install-optional-empty"></a>

### 176. Installer rejects an unresolved optional dependency with an empty name

1 file. Category `c`. The install success marker is false. Spec-name validation runs before the optional dependency can be skipped.

Test subject `install does not abort on an unresolved optional dependency with an empty name (#31652)`. Throwing frame `at <anonymous> (/bun/test/regression/issue/31652.test.ts:118:93)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/install/resolve.rs:56](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/resolve.rs#L56). Reproducer `suite quickjs 'regression/issue/31652.test.ts'`.

<a id="cause-large-buffer-wording"></a>

### 177. Large Buffer allocation uses the wasm limit rather than JSC's wording

1 file. Category `e`. The 64-GiB request already throws RangeError at the wasm32 buffer limit. Retain e because the guest cannot represent that native address range. Copying JSC's typed-array-limit wording would falsely attribute a wasm32 allocation guard to JSC and add an engine-specific diagnostic special case without changing the correct rejection behavior.

Test subject `Buffer.concat throws RangeError for too large buffers`. Throwing frame `at <anonymous> (/bun/test/js/node/buffer-concat.test.ts:10:40)`.

Observed diagnostic:

```text
Expected pattern: /JavaScriptCore typed arrays are currently limited to/
Received message: "The value of \"size\" is out of range. It must be >= 0 && <= 4294967296. Received 68_719_476_736"
```

Suspected implementation [crates/bunwasm-runtime/src/js/buffer.js:524](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/buffer.js#L524). Reproducer `suite quickjs 'js/node/buffer-concat.test.ts'`.

<a id="cause-url-legacy-ipv6"></a>

### 178. Legacy url.parse retains IPv6 brackets in hostname

1 file. Category `c`. The expected hostname is ::1 and the actual hostname is [::1]. Host retains brackets, but hostname must not.

Test subject `Url.prototype.parse > accepts ipv6 host`. Throwing frame `at <anonymous> (/bun/test/js/node/url/url.test.ts:22:35)`.

Observed diagnostic:

```text
- {
-   "hostname": "::1",
+ Url {
+   "hostname": "[::1]",
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_url.js:49](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_url.js#L49). Reproducer `suite quickjs 'js/node/url/url.test.ts'`.

<a id="cause-legacy-url-coercion"></a>

### 179. Legacy url.parse swallows primitive exceptions during argument description

1 file. Category `c`. The fixture prints did not throw for several primitive exceptions instead of rethrown followed by the original primitive. Inspect invalid-argument formatting and coercion order.

Test subject `url.parse > rethrows a primitive thrown while describing the argument`. Throwing frame `at <anonymous> (/bun/test/js/node/url/url-parse-invalid-input.test.js:148:20)`.

Observed diagnostic:

```text
- rethrown nope
- rethrown nope
- rethrown 1
+ did not throw
+ did not throw
+ did not throw
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_url.js:49](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_url.js#L49). Reproducer `suite quickjs 'js/node/url/url-parse-invalid-input.test.js'`.

<a id="cause-compiled-cjs-marker"></a>

### 180. Malformed @bun-cjs text wrappers are not rejected

1 file. Category `c`. The fixture is ordinary text headed @bun @bun-cjs, without the required function wrapper. It executes as CommonJS instead of producing the wrapper diagnostic. This check needs text-format validation, not native machine-code or bytecode execution, so it is a bounded loader gap.

Test subject `commonjs-invalid > Loading an invalid commonjs module`. Throwing frame `at <anonymous> (/bun/test/cli/run/commonjs-invalid.test.ts:17:27)`.

Observed diagnostic:

```text
Expected to contain: "Expected CommonJS module to have a function wrapper"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:30](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L30). Reproducer `suite quickjs 'cli/run/commonjs-invalid.test.ts'`.

<a id="cause-formdata-inspect"></a>

### 181. Matcher formatting omits FormData's non-callable toJSON property

1 file. Category `c`. The diagnostic does not contain the expected toJSON:42 property. It must print the property without invoking it or dropping it because the object is FormData.

Test subject `failing matcher on FormData without a callable toJSON does not abort the test runner`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/expect-formdata-tojson-crash.test.ts:43:18)`.

Observed diagnostic:

```text
Expected to contain: "\"toJSON\": 42"
Received: "\nformdata.test.ts:\n2 |       import { test, expect } from \"bun:test\";\n3 | \n4 |       test(\"toJSON shadowed with undefined\", () => {\n5 |         const fd = new FormData();\n6 |         Object.definePro
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:330](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L330). Reproducer `suite quickjs 'js/bun/test/expect-formdata-tojson-crash.test.ts'`.

<a id="cause-messageevent-init"></a>

### 182. MessageEvent.initMessageEvent is absent

1 file. Category `c`. The child calls the legacy initialization method during BroadcastChannel delivery and fails before its completion marker. This is an event API gap rather than a measured GC race.

Test subject `MessageEvent.initMessageEvent does not race GC visitor on m_data`. Throwing frame `at <anonymous> (/bun/test/js/web/broadcastchannel/message-event-init-gc.test.ts:74:28)`.

Observed diagnostic:

```text
- ""
+ "23 |       for (let i = 0; i < N; i++) bc1.postMessage({ big: new ArrayBuffer(1024 * 64), i });
+ 24 |       await delivered;
+ 25 |       // Each fresh event's m_data is a Ref<SerializedScriptValue>; this
```

Suspected implementation [crates/bunwasm-runtime/src/js/worker_threads.ts:94](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/worker_threads.ts#L94). Reproducer `suite quickjs 'js/web/broadcastchannel/message-event-init-gc.test.ts'`.

<a id="cause-mkdir-existing"></a>

### 183. mkdir recursive accepts an existing file as a directory

1 file. Category `c`. Creating recursively over a regular file should throw EEXIST. The call returns without throwing.

Test subject `fs.mkdir recursive should not error on existing`. Throwing frame `at <anonymous> (/bun/test/regression/issue/16474.test.ts:40:6)`.

Observed diagnostic:

```text
Expected substring: "EEXIST: file already exists"
Received function did not throw
Received value: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:368](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L368). Reproducer `suite quickjs 'regression/issue/16474.test.ts'`.

<a id="cause-error-code-mirror"></a>

### 184. Native error translation loses stable Node error codes

1 file. Category `c`. Expected named ERR_* codes become undefined on TypeErrors. Inspect native-to-engine error construction before changing diagnostic messages.

Test subject `Rust-thrown error codes round-trip through Bun__createErrorWithCode`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/error-code-mirror.test.ts:50:69)`.

Observed diagnostic:

```text
- ERR_ENCODING_INVALID_ENCODED_DATA:TypeError
- ERR_INVALID_ARG_TYPE:TypeError
- ERR_INVALID_ARG_VALUE:TypeError
+ undefined:TypeError
+ undefined:TypeError
+ undefined:TypeError
```

Suspected implementation [crates/bunwasm-runtime/src/natives.rs:59](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/natives.rs#L59). Reproducer `suite quickjs 'js/bun/util/error-code-mirror.test.ts'`.

<a id="cause-f-fetch-keepalive"></a>

### 185. Native fetch omits its default Connection header

1 file. Category `f`. The raw request has no connection header instead of keep-alive. Browser fully passes. The native host fetch path and browser fetch path differ.

Test subject `fetch Connection header > should default to keep-alive when no Connection header provided`. Throwing frame `at <anonymous> (/bun/test/js/web/fetch/fetch-connection-header.test.ts:74:32)`.

Observed diagnostic:

```text
Expected: "keep-alive"
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:150](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L150). Reproducer `suite quickjs 'js/web/fetch/fetch-connection-header.test.ts'`.

<a id="cause-node-error-tostring"></a>

### 186. Node error toString omits the bracketed error code

1 file. Category `c`. The error has code ERR_INVALID_ARG_TYPE, but String(error) is TypeError:message instead of TypeError [ERR_INVALID_ARG_TYPE]:message.

Test subject `node error toString() > formats name, code and message`. Throwing frame `at <anonymous> (/bun/test/js/node/errors/error-code-toString-receiver.test.ts:20:56)`.

Observed diagnostic:

```text
-   "string": "TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined",
+   "string": "TypeError: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined",
```

Suspected implementation [crates/bunwasm-runtime/src/natives.rs:59](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/natives.rs#L59). Reproducer `suite quickjs 'js/node/errors/error-code-toString-receiver.test.ts'`.

<a id="cause-worker-dispose"></a>

### 187. Node Worker lacks Symbol.asyncDispose

1 file. Category `c`. The disposal property is undefined rather than a function that terminates the worker.

Test subject `Worker implements Symbol.asyncDispose`. Throwing frame `at <anonymous> (/bun/test/js/node/worker_threads/worker-async-dispose.test.ts:23:46)`.

Observed diagnostic:

```text
Expected: "function"
Received: "undefined"
```

Suspected implementation [crates/bunwasm-runtime/src/js/worker_threads.ts:526](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/worker_threads.ts#L526). Reproducer `suite quickjs 'js/node/worker_threads/worker-async-dispose.test.ts'`.

<a id="cause-dns-order"></a>

### 188. node:dns lacks getDefaultResultOrder

1 file. Category `c`. The child cannot report a function for getDefaultResultOrder. The DNS module is a stub rather than a complete compatibility wrapper.

Test subject `dns.getDefaultResultOrder is a function returning a string`. Throwing frame `at <anonymous> (/bun/test/regression/issue/28948.test.ts:26:16)`.

Observed diagnostic:

```text
Expected: "function"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:789](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L789). Reproducer `suite quickjs 'regression/issue/28948.test.ts'`.

<a id="cause-module-source-map"></a>

### 189. node:module.SourceMap is an empty class

1 file. Category `c`. The instance has no payload property. It receives undefined rather than the constructor's source-map payload object.

Test subject `Can create SourceMap instance from node:module`. Throwing frame `at <anonymous> (/bun/test/js/node/module/module-sourcemap.test.js:27:29)`.

Observed diagnostic:

```text
Expected: {
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:287](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L287). Reproducer `suite quickjs 'js/node/module/module-sourcemap.test.js'`.

<a id="cause-process-tty"></a>

### 190. Non-TTY stdin reports false instead of undefined

1 file. Category `c`. The Node compatibility fixture expects an absent isTTY property on a non-terminal stream. The adapter supplies false.

Test subject `process-stdio > process.stdin`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-stdio.test.ts:10:33)`.

Observed diagnostic:

```text
Expected: undefined
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:125](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L125). Reproducer `suite quickjs 'js/node/process/process-stdio.test.ts'`.

<a id="cause-os-arch"></a>

### 191. os.arch truthfully reports wasm32 rather than a native CPU

1 file. Category `a`. The fixture accepts only x64, x86 or arm64 and receives false for the wasm32 guest architecture. os.arch delegates to process.arch. A wasm32-wasip1 artifact has a wasm32 address model regardless of the launcher's CPU. The platform gap is the upstream native-CPU allowlist, not an absent getter.

Test subject `arch`. Throwing frame `at <anonymous> (/bun/test/js/node/os/os.test.js:8:68)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:40](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L40). Reproducer `suite quickjs 'js/node/os/os.test.js'`.

<a id="cause-install-quiet"></a>

### 192. Package packing setup rejects --quiet

1 file. Category `c`. The pm diff fixture cannot create its input package because its setup command rejects quiet. This is earlier than comparing package contents.

Test subject `(unnamed)`. Throwing frame `at pack (/bun/test/cli/install/bun-pm-diff.test.ts:44:41)`.

Observed diagnostic:

```text
| !tgz) throw new Error("pack failed: " + stderr);                                              ^
error: pack failed: error: Unknown install option: --quiet
```

Suspected implementation [crates/bunwasm-runtime/src/install/mod.rs:54](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/install/mod.rs#L54). Reproducer `suite quickjs 'cli/install/bun-pm-diff.test.ts'`.

<a id="cause-boxed-paths"></a>

### 193. Path helpers reject boxed String values used by the fixture

1 file. Category `c`. The coercion-and-GC fixture receives validation errors instead of its OK lines. The path wrapper accepts only primitive strings before invoking coercion hooks.

Test subject `String-object arguments whose toPrimitive triggers GC do not corrupt earlier arguments`. Throwing frame `at <anonymous> (/bun/test/js/node/path/path.test.js:114:56)`.

Observed diagnostic:

```text
-     "posix.join[0]=OK",
-     "posix.join[1]=OK",
-     "posix.join[2]=OK",
+     "posix.join[0]=MISMATCH",
+     "posix.join[1]=MISMATCH",
+     "posix.join[2]=MISMATCH",
```

Suspected implementation [crates/bunwasm-runtime/src/js/path.js:15](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/path.js#L15). Reproducer `suite quickjs 'js/node/path/path.test.js'`.

<a id="cause-path-win32"></a>

### 194. path.win32.dirname delegates to POSIX behavior

1 file. Category `c`. dirname of a Windows drive root returns dot instead of c backslash. This is a path algorithm gap, not a host-platform limitation.

Test subject `browserify path tests > dirname > path.win32.dirname`. Throwing frame `at <anonymous> (/bun/test/js/node/path/browserify.test.js:82:42)`.

Observed diagnostic:

```text
Expected: "c:\"
Received: "."
```

Suspected implementation [crates/bunwasm-runtime/src/js/path.js:355](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/path.js#L355). Reproducer `suite quickjs 'js/node/path/browserify.test.js'`.

<a id="cause-performance-resource"></a>

### 195. performance.clearResourceTimings is absent

1 file. Category `c`. Resource timing cleanup is not implemented on the performance object.

Test subject `performance.clearResourceTimings()`. Throwing frame `at <anonymous> (/bun/test/js/web/timers/performance.test.js:5:15)`.

Observed diagnostic:

```text
performance.clearResourceTimings();                   ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:1150](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L1150). Reproducer `suite quickjs 'js/web/timers/performance.test.js'`.

<a id="cause-performance-json"></a>

### 196. performance.toJSON returns only timeOrigin

1 file. Category `c`. The fixture expects two serialized keys and receives one. The implementation explicitly returns only timeOrigin. The fixture does not name its expected second property, so do not infer one from this assertion alone.

Test subject `performanceToJSON`. Throwing frame `at ::bunternal:: (/bun/test/js/deno/harness.ts:105:20)`.

Observed diagnostic:

```text
Expected: 2
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:1181](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L1181). Reproducer `suite quickjs 'js/deno/performance/performance.test.ts'`.

<a id="cause-argv-bun-flag"></a>

### 197. process.argv omits the leading --bun argument expected by parseArgs

1 file. Category `c`. The default-args helper receives an empty option list instead of --bun. The CLI consumes the flag without exposing the expected argument vector.

Test subject `parseArgs default args > running "bun --bun file-test.js --foo asdf"`. Throwing frame `at <anonymous> (/bun/test/js/node/util/parse_args/default-args.test.mjs:77:32)`.

Observed diagnostic:

```text
- [
-   "--bun",
- ]
+ []
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:178](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L178). Reproducer `suite quickjs 'js/node/util/parse_args/default-args.test.mjs'`.

<a id="cause-dlopen-rejection-code"></a>

### 198. process.dlopen rejection omits ERR_DLOPEN_FAILED

1 file. Category `c`. All five raw failures already reject the input, but print CODE:undefined instead of ERR_DLOPEN_FAILED. Reporting the public rejection code needs no successful native addon load. The native ELF guard and library execution paths remain unmeasured.

Test subject `issue #15753: glibc addon on musl throws instead of segfaulting > glibc-linked addon (libc.so.6) is rejected with ERR_DLOPEN_FAILED`. Throwing frame `at <anonymous> (/bun/test/regression/issue/15753.test.ts:116:22)`.

Observed diagnostic:

```text
Expected to contain: "CODE:ERR_DLOPEN_FAILED"
Received: "CODE:undefined\nMSG:process.dlopen is not supported in bun-wasm\n"
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:253](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L253). Reproducer `suite quickjs 'regression/issue/15753.test.ts'`.

<a id="cause-process-execve"></a>

### 199. process.execve has no host process-replacement capability

1 file. Category `a`. The first assertion sees an absent function. The file also requires native execve behavior: replace the calling process image while preserving its process identity and inherited descriptors. WASI preview1 has no execve, and this host runs child guests as independent stores on threads in one launcher. Its spawn ABI starts a new Bun instance and cannot replace a native process image.

Test subject `process.execve > is a function`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-execve.test.ts:7:35)`.

Observed diagnostic:

```text
Expected: "function"
Received: "undefined"
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:178](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L178). Reproducer `suite quickjs 'js/node/process/process-execve.test.ts'`.

<a id="cause-nexttick-order"></a>

### 200. process.nextTick drains before the engine finishes the current microtask queue

1 file. Category `d`. Actual order is microtask,tick,microtask 2,next,immediate instead of microtask,microtask 2,tick,next,immediate. This is queue ownership and ordering.

Test subject `after the tick queue went idle, a tick that a microtask schedules runs in the same checkpoint, after the microtasks`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-nexttick.test.js:78:40)`.

Observed diagnostic:

```text
-   "stdout": "microtask microtask 2 tick next immediate
+   "stdout": "microtask tick microtask 2 next immediate
```

Suspected implementation [crates/bunwasm-runtime/src/js/bootstrap.js:389](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L389). Reproducer `suite quickjs 'js/node/process/process-nexttick.test.js'`.

<a id="cause-process-ppid"></a>

### 201. process.ppid is a data property instead of an accessor

1 file. Category `c`. The first assertion checks the property descriptor and receives no getter. Installing an accessor requires no OS parent-process lookup. A later test independently fails to open /proc/self/stat; that later platform dependency does not explain the first descriptor mismatch.

Test subject `process.ppid is a live accessor (#29169)`. Throwing frame `at <anonymous> (/bun/test/regression/issue/29169.test.ts:35:30)`.

Observed diagnostic:

```text
Expected: "function"
Received: "undefined"
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:197](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L197). Reproducer `suite quickjs 'regression/issue/29169.test.ts'`.

<a id="cause-setgroups"></a>

### 202. process.setgroups input validation is absent

1 file. Category `c`. The accessor test expects its getter error to propagate and receives not a function because setgroups is absent. Reading and validating an input array needs no host credential change. A valid setgroups operation may need a future host capability, but this first failure is argument validation.

Test subject `process.setgroups > propagates exceptions thrown from an accessor`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-array-accessor-crash.test.ts:22:46)`.

Observed diagnostic:

```text
Expected substring: "getter threw"
Received message: "not a function"
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:178](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L178). Reproducer `suite quickjs 'js/node/process/process-array-accessor-crash.test.ts'`.

<a id="cause-stdin-ref-type"></a>

### 203. process.stdin exposes ref for file input where Bun leaves it undefined

1 file. Category `c`. The snapshot receives function instead of undefined for a file-backed stdin ref member.

Test subject `file does the right thing`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-stdin.test.ts:29:38)`.

Observed diagnostic:

```text
- "undefined
+ "function
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:125](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L125). Reproducer `suite quickjs 'js/node/process/process-stdin.test.ts'`.

<a id="cause-process-title"></a>

### 204. process.title is fixed to bun instead of the executable path

1 file. Category `c`. The title is bun while the fixture expects process.execPath. This is a public process property mismatch.

Test subject `process.title should return a non-empty string or fallback to 'bun'`. Throwing frame `at <anonymous> (/bun/test/regression/issue/23183.test.ts:49:19)`.

Observed diagnostic:

```text
Expected: "/usr/local/bin/bun"
Received: "bun"
```

Suspected implementation [crates/bunwasm-runtime/src/js/process.js:178](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/process.js#L178). Reproducer `suite quickjs 'regression/issue/23183.test.ts'`.

<a id="cause-f-duration"></a>

### 205. QuickJS Intl shim has no DurationFormat

1 file. Category `f`. Intl.DurationFormat is not callable in the English-only shim. The same upstream file fully passes on JSC and browser.

Test subject `WebKit dbdca7545d upgrade > Intl.DurationFormat keeps the minus sign of a fraction between -1 and 0 (501d1f661f9)`. Throwing frame `at format (/bun/test/js/bun/jsc/webkit-upgrade-dbdca7545d.test.ts:85:11)`.

Observed diagnostic:

```text
new Intl.DurationFormat("en", options).format(duration);                ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/intl.js:9](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/intl.js#L9). Reproducer `suite quickjs 'js/bun/jsc/webkit-upgrade-dbdca7545d.test.ts'`.

<a id="cause-f-als-thenable"></a>

### 206. QuickJS loses AsyncLocalStorage context across custom thenable assimilation

1 file. Category `f`. The thenable sees undefined instead of the stored verifier symbol. JSC fully passes. This is promise-context propagation rather than the separate defaultValue option gap.

Test subject `await custom thenable`. Throwing frame `at ::bunternal:: (/bun/test/js/node/harness.ts:18:16)`.

Observed diagnostic:

```text
- Symbol(verifier)
+ actual - expected
+ undefined
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:259](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L259). Reproducer `suite quickjs 'js/node/async_hooks/async-local-storage-thenable.test.ts'`.

<a id="cause-f-promise-try"></a>

### 207. QuickJS Promise.try wraps a returned promise instead of preserving identity

1 file. Category `f`. Expected and received both inspect as resolved Promise objects, but identity differs. JSC fully passes. Suspect the engine's Promise.try implementation, not the inspector.

Test subject `WebKit 8c4fd56347 upgrade > Promise.try returns a native promise as-is (7f38ebbabf)`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/webkit-upgrade-8c4fd56347.test.ts:12:34)`.

Observed diagnostic:

```text
Expected: Promise { <resolved> }
Received: serializes to the same string
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:138](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L138). Reproducer `suite quickjs 'js/bun/jsc/webkit-upgrade-8c4fd56347.test.ts'`.

<a id="cause-import-defer"></a>

### 208. QuickJS receives import defer syntax without a lowering pass

1 file. Category `d`. The child reports from clause expected at import defer. The syntax is not supported by the engine and is not transformed by the guest loader.

Test subject `import defer > defers module evaluation until a property is accessed`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/import-defer.test.ts:36:20)`.

Observed diagnostic:

```text
- ""
+ "1 |
+ 2 |         import defer * as ns from "./dep.js";
+                          ^
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:251](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L251). Reproducer `suite quickjs 'js/bun/resolve/import-defer.test.ts'`.

<a id="cause-f-disposal-wording"></a>

### 209. QuickJS says disposable where the fixture searches for dispose

1 file. Category `f`. The expected TypeError is thrown, but value is not disposable does not contain dispose. JSC and browser fully pass. This is a measured message mismatch; no platform or cost exclusion is established by it.

Test subject `'using' in a CommonJS module does not emit an ESM import inside the CJS wrapper`. Throwing frame `at <anonymous> (/bun/test/regression/issue/11100.test.ts:39:32)`.

Observed diagnostic:

```text
Expected to contain: "dispose"
Received: "1 | const path = require(\"node:path\");\n                 ^\ntypeerror: value is not disposable\n      at /tmp/issue-11100_r8wiaf/entry.cjs:1:14\n\nbun v1.4.4 (wasi wasm32)\n"
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:243](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L243). Reproducer `suite quickjs 'regression/issue/11100.test.ts'`.

<a id="cause-f-nul-source"></a>

### 210. QuickJS source loading truncates or rejects NUL in template literals

1 file. Category `f`. The child prints no string lengths instead of 1 and 0. Browser fully passes. The observed difference is source containing NUL across the engine boundary; byte-length handling is the suspected cause and still needs a native adapter trace.

Test subject `String.raw preserves null bytes in tagged template literals`. Throwing frame `at <anonymous> (/bun/test/regression/issue/27553.test.ts:27:18)`.

Observed diagnostic:

```text
- "1
- 0
- "
+ ""
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:243](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L243). Reproducer `suite quickjs 'regression/issue/27553.test.ts'`.

<a id="cause-public-promise-then"></a>

### 211. readableStreamToArrayBuffer calls a patched Promise.prototype.then

1 file. Category `c`. The fixture observes five public then calls rather than zero. Internal stream conversion must use the engine's promise operations or a captured intrinsic.

Test subject `readableStreamToArrayBuffer does not call a patched Promise.prototype.then`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/readablestreamtoarraybuffer.test.ts:25:21)`.

Observed diagnostic:

```text
Expected: 0
Received: 5
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:492](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L492). Reproducer `suite quickjs 'js/bun/util/readablestreamtoarraybuffer.test.ts'`.

<a id="cause-fs-recursive-links"></a>

### 212. readdir recursive skips symlink error traversal

1 file. Category `c`. The child reports that readdirSync did not throw when the symlink-loop fixture expected its error path. Do not claim a leak measurement from the untriggered path.

Test subject `readdirSync({recursive:true, withFileTypes:true}) error path does not leak Dirent.path`. Throwing frame `at <anonymous> (/bun/test/js/node/fs/readdirSync-recursive-error-leak.test.ts:29:20)`.

Observed diagnostic:

```text
- ""
+ "45 | try {
+ 46 |   fs.readdirSync(root, { recursive: true, withFileTypes: true });
+ 47 | } catch {
```

Suspected implementation [crates/bunwasm-runtime/src/js/node_fs.js:386](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/node_fs.js#L386). Reproducer `suite quickjs 'js/node/fs/readdirSync-recursive-error-leak.test.ts'`.

<a id="cause-redis"></a>

### 213. RedisClient and Bun.redis are absent

1 file. Category `d`. The child cannot print its loaded Redis URL marker because the API is missing. This is earlier than URL parsing or Redis network access.

Test subject `Redis loads with REDIS_URL=localhost:6379`. Throwing frame `at <anonymous> (/bun/test/regression/issue/24385.test.ts:35:18)`.

Observed diagnostic:

```text
Expected to contain: "success"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun.js:449](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun.js#L449). Reproducer `suite quickjs 'regression/issue/24385.test.ts'`.

<a id="cause-report-error"></a>

### 214. reportError output and stack columns differ from Bun's public formatter

1 file. Category `c`. The error stack points to column 1 instead of 17, and primitive-value output lacks Bun's repeated error labels. Match this public formatter instead of normalizing the test snapshot.

Test subject `reportError`. Throwing frame `at <anonymous> (/bun/test/js/bun/util/reportError.test.ts:21:80)`.

Observed diagnostic:

```text
-                     ^
- error: reportError Test!
-       at [file]:1:17
+     ^
+ ReferenceError: reportError is not defined
+       at [file]:1:1
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2018](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2018). Reproducer `suite quickjs 'js/bun/util/reportError.test.ts'`.

<a id="cause-request-cache"></a>

### 215. Request.cache is absent

1 file. Category `c`. A default Request exposes undefined instead of default for its cache mode.

Test subject `Request cache option is set correctly`. Throwing frame `at <anonymous> (/bun/test/regression/issue/2993.test.ts:8:27)`.

Observed diagnostic:

```text
Expected: "default"
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:1029](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L1029). Reproducer `suite quickjs 'regression/issue/2993.test.ts'`.

<a id="cause-invalid-this"></a>

### 216. Request.formData receiver validation omits ERR_INVALID_THIS

1 file. Category `c`. formData is an async unsupported stub with no synchronous receiver brand check. The call returns a rejected Promise, so the fixture reaches expect.unreachable and catches an Error with code undefined instead of the required synchronous ERR_INVALID_THIS TypeError.

Test subject `ERR_INVALID_THIS`. Throwing frame `at <anonymous> (/bun/test/js/bun/globals.test.js:10:20)`.

Observed diagnostic:

```text
Expected: "ERR_INVALID_THIS"
Received: undefined
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:922](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L922). Reproducer `suite quickjs 'js/bun/globals.test.js'`.

<a id="cause-require-async-module"></a>

### 217. require does not deliver the expected transitive-TLA TypeError

1 file. Category `d`. The child's guard never sees both a TypeError and an async module message for its transitive top-level-await dependency. Inspect transitive asynchronous module state; the guard alone does not distinguish a normal return from a different thrown error.

Test subject `require(esm) rejects when a transitive dependency has top-level await`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/require-esm-transitive-tla.test.ts:45:18)`.

Observed diagnostic:

```text
- ""
+ "3 |       try {
+ 4 |         require("./middle.mjs");
+ 5 |       } catch (e) {
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:139](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L139). Reproducer `suite quickjs 'js/bun/resolve/require-esm-transitive-tla.test.ts'`.

<a id="cause-module-children"></a>

### 218. require leaves CommonJS module.children empty

1 file. Category `c`. Module constructs children as an empty array, but loadModule creates every child with parent undefined and does not attach it to the referrer. The fixture throws children missing before its completion marker. This is module relationship tracking, not concurrent GC.

Test subject `JSCommonJSModule m_children mutation under concurrent GC`. Throwing frame `at <anonymous> (/bun/test/js/node/module/module-children-concurrent-gc.test.ts:73:27)`.

Observed diagnostic:

```text
Expected: "ok 1"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/bootstrap.js:482](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L482). Reproducer `suite quickjs 'js/node/module/module-children-concurrent-gc.test.ts'`.

<a id="cause-response-json-validation"></a>

### 219. Response.json accepts values JSON.stringify cannot serialize

1 file. Category `c`. A Symbol produces a Response with a null body instead of throwing Value is not JSON serializable.

Test subject `Response.json() throws TypeError for non-JSON serializable top-level values`. Throwing frame `at <anonymous> (/bun/test/regression/issue/21257.test.ts:9:47)`.

Observed diagnostic:

```text
Expected substring: "Value is not JSON serializable"
Received function did not throw
Received value: Response {
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:874](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L874). Reproducer `suite quickjs 'regression/issue/21257.test.ts'`.

<a id="cause-tsconfig-paths"></a>

### 220. Runtime resolution ignores inherited tsconfig path mappings

1 file. Category `d`. The child cannot find @leaf/thing after the extends merge. Runtime package lookup has no corresponding paths mapping stage.

Test subject `tsconfig 'extends' merge still works after freeing intermediates`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/tsconfig-extends-leak.test.ts:121:18)`.

Observed diagnostic:

```text
- ""
+ "error: Cannot find package '@leaf/thing' from '/tmp/tsconfig-extends-merge_6Nega4/index.ts'
+  specifier: "@leaf/thing",
+       code: "ERR_MODULE_NOT_FOUND"
```

Suspected implementation [crates/bunwasm-runtime/src/resolve.rs:160](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/resolve.rs#L160). Reproducer `suite quickjs 'js/bun/resolve/tsconfig-extends-leak.test.ts'`.

<a id="cause-shadowrealm"></a>

### 221. ShadowRealm constructor is absent

1 file. Category `d`. The failing child constructs ShadowRealm and prints no ok marker. This is an absent realm API, not evidence that concurrent GC failed. A portable realm implementation would be substantial work, but the record supplies no platform impossibility or explicit reason to exclude it.

Test subject `Zig::GlobalObject creation on a warm VM under concurrent GC > ShadowRealm creation survives concurrent GC`. Throwing frame `at <anonymous> (/bun/test/regression/issue/29519.test.ts:89:27)`.

Observed diagnostic:

```text
Expected: "ok"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:138](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L138). Reproducer `suite quickjs 'regression/issue/29519.test.ts'`.

<a id="cause-negative-vlq"></a>

### 222. Stack mapping does not report invalid source-map VLQ column values

1 file. Category `c`. The child emits no InvalidGeneratedColumnValue diagnostic for the deliberately invalid external source map. Inspect map validation separately from parser error wording.

Test subject `sourcemap: negative VLQ delta in mappings is rejected, not asserted > external .map: negative generated column`. Throwing frame `at <anonymous> (/bun/test/js/bun/sourcemap/negative-vlq-mapping.test.ts:47:22)`.

Observed diagnostic:

```text
Expected to contain: "InvalidGeneratedColumnValue"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/stack_trace.js:1](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/stack_trace.js#L1). Reproducer `suite quickjs 'js/bun/sourcemap/negative-vlq-mapping.test.ts'`.

<a id="cause-parser-native-wording"></a>

### 223. Stack-overflow message parity omits a trailing period

1 file. Category `c`. The child reports the expected RangeError class, but its message lacks the final period in Bun's expected text. The record demonstrates a bounded public diagnostic mismatch. No host limitation or cost reason for excluding this assertion is established.

Test subject `expect().toMatchObject() throws RangeError on deeply nested objects instead of crashing`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/expect-stack-overflow-crash.test.ts:55:18)`.

Observed diagnostic:

```text
- "true Maximum call stack size exceeded.
+ "true Maximum call stack size exceeded
```

Suspected implementation [crates/bunwasm-runtime/src/engine_quickjs.rs:243](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/engine_quickjs.rs#L243). Reproducer `suite quickjs 'js/bun/test/expect-stack-overflow-crash.test.ts'`.

<a id="cause-static-conditional"></a>

### 224. Static Bun.file routes ignore If-Modified-Since

1 file. Category `c`. The fixture sends an If-Modified-Since date in the future and receives 200 instead of 304. Conditional response handling is missing before any descriptor-leak measurement can be interpreted.

Test subject `Bun.serve static file route: graceful stop resolves after 304 / HEAD`. Throwing frame `at <anonymous> (/bun/test/regression/issue/29181.test.ts:88:22)`.

Observed diagnostic:

```text
Expected: 304
Received: 200
```

Suspected implementation [crates/bunwasm-runtime/src/js/net.js:591](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/net.js#L591). Reproducer `suite quickjs 'regression/issue/29181.test.ts'`.

<a id="cause-temporal-toggle"></a>

### 225. Temporal installation ignores BUN_JSC_useTemporal=0

1 file. Category `c`. The child sees a Temporal object instead of undefined. The portable shim is lazily installed whenever the global is absent and does not check the opt-out environment flag. Honoring that installation choice does not require changing native JSC internals.

Test subject `BUN_JSC_useTemporal=0 disables Temporal`. Throwing frame `at <anonymous> (/bun/test/js/bun/jsc/temporal-global.test.ts:24:40)`.

Observed diagnostic:

```text
-   "stderr": Any<String>,
-   "stdout": "undefined",
+   "stderr": "",
+   "stdout": "object",
```

Suspected implementation [crates/bunwasm-runtime/src/js/bootstrap.js:799](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L799). Reproducer `suite quickjs 'js/bun/jsc/temporal-global.test.ts'`.

<a id="cause-failing-validation"></a>

### 226. test.failing reports collection state before validating its callback

1 file. Category `c`. The missing callback should report test.failing expects a function as the second argument. It instead reports that test or describe was called outside a test file.

Test subject `test.failing > requires a test function (unlike test.todo)`. Throwing frame `at <anonymous> (/bun/test/js/bun/test/test-failing.test.ts:18:45)`.

Observed diagnostic:

```text
Expected substring: "test.failing expects a function as the second argument"
Received message: "Cannot call test() or describe() outside of a test file"
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:1707](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L1707). Reproducer `suite quickjs 'js/bun/test/test-failing.test.ts'`.

<a id="cause-encoding-ascii"></a>

### 227. TextDecoder ASCII labels do not use Windows-1252 mappings

1 file. Category `c`. Bytes 0x89,0x95,0x9f become C1 controls rather than the expected per-mille, bullet and Y-diaeresis characters.

Test subject `textDecoderASCII`. Throwing frame `at ::bunternal:: (/bun/test/js/deno/harness.ts:105:20)`.

Observed diagnostic:

```text
Expected: "‰•Ÿ¿"
Received: "¿"
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:62](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L62). Reproducer `suite quickjs 'js/deno/encoding/encoding.test.ts'`.

<a id="cause-css-entry-diagnostic"></a>

### 228. The CLI accepts a CSS entry instead of rejecting an unsupported run target

1 file. Category `c`. Running an existing CSS file produces no Cannot run diagnostic. Distinguish executable entry loader validation from importing CSS as a module.

Test subject `running unsupported file types shows helpful error message instead of 'File not found'`. Throwing frame `at <anonymous> (/bun/test/regression/issue/1365.test.ts:23:18)`.

Observed diagnostic:

```text
Expected to contain: "Cannot run"
Received: ""
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:408](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L408). Reproducer `suite quickjs 'regression/issue/1365.test.ts'`.

<a id="cause-custom-conditions"></a>

### 229. The CLI rejects --conditions before resolving conditional exports

1 file. Category `c`. The first child uses --conditions=first, which reaches the unknown-flag arm and exits 1. The resolver also has a fixed condition list, but that is a later gap after CLI parsing.

Test subject `custom condition 'import' in package.json resolves`. Throwing frame `at <anonymous> (/bun/test/js/bun/resolve/import-custom-condition.test.ts:89:20)`.

Observed diagnostic:

```text
Expected: 0
Received: 1
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:416](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L416). Reproducer `suite quickjs 'js/bun/resolve/import-custom-condition.test.ts'`.

<a id="cause-wasm-entry"></a>

### 230. The CLI treats a .wasm program as JavaScript source

1 file. Category `d`. A hello-world wasm executable fails SyntaxError: source contains NUL rather than invoking a WASI instance. WebAssembly JS API support is a separate path.

Test subject `Should support printing 'hello world'`. Throwing frame `at <anonymous> (/bun/test/js/bun/wasm/wasi.test.js:20:6)`.

Observed diagnostic:

```text
-   "exitCode": 0,
-   "stderr": "",
-   "stdout": "hello world
+   "exitCode": 1,
+   "stderr": "SyntaxError: source contains NUL
+
```

Suspected implementation [crates/bunwasm-cli/src/main.rs:408](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-cli/src/main.rs#L408). Reproducer `suite quickjs 'js/bun/wasm/wasi.test.js'`.

<a id="cause-shard"></a>

### 231. The runner ignores shard arguments and validation

1 file. Category `c`. An invalid shard invocation runs all ten fixture tests instead of emitting the expected --shard diagnostic.

Test subject `--shard > partitions test files across shards with no overlap or gaps`. Throwing frame `at <anonymous> (/bun/test/cli/test/test-shard.test.ts:41:24)`.

Observed diagnostic:

```text
Expected to contain: "--shard="
Received: "\nf00.test.ts:\n(pass) t [6.91ms]\n\nf01.test.ts:\n(pass) t\n\nf02.test.ts:\n(pass) t\n\nf03.test.ts:\n(pass) t\n\nf04.test.ts:\n(pass) t\n\nf05.test.ts:\n(pass) t\n\nf06.test.ts:\n(pass) t\n\nf07.test.ts:\n(p
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2301](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2301). Reproducer `suite quickjs 'cli/test/test-shard.test.ts'`.

<a id="cause-async-preload"></a>

### 232. The test runner ignores a preload flag passed in equals form

1 file. Category `c`. The fixture passes --preload=<path>. The runner only handles the separate --preload value form, leaving MY_ENV undefined before the test begins.

Test subject `async preload is awaited before tests run (sequential (default))`. Throwing frame `at <anonymous> (/bun/test/regression/issue/30887.test.ts:60:18)`.

Observed diagnostic:

```text
Expected to contain: "1 pass"
Received: "\nmy.test.ts:\n1 | \n2 |       import { test, expect } from \"bun:test\";\n3 |       test(\"MY_ENV must not be undefined\", () => {\n4 |         expect(Bun.env.MY_ENV).toBe(\"MUST_NOT_BE_UNDEFINED\");\n
```

Suspected implementation [crates/bunwasm-runtime/src/js/bun_test.js:2308](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bun_test.js#L2308). Reproducer `suite quickjs 'regression/issue/30887.test.ts'`.

<a id="cause-url-opaque-origin"></a>

### 233. The URL host parser serializes an opaque scheme origin as null

1 file. Category `c`. For ftps:/example.com the hostname is empty and href matches, but origin is null instead of ftps:. The first WPT section differs only in this scheme-origin field.

Test subject `WPT url-constructor > section 0: See ../README.md for a description of the format. (110 entries)`. Throwing frame `at <anonymous> (/bun/test/js/web/url/url-wpt-constructor.test.ts:140:26)`.

Observed diagnostic:

```text
- []
+ [
+   {
+     "actual": {
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:388](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L388). Reproducer `suite quickjs 'js/web/url/url-wpt-constructor.test.ts'`.

<a id="cause-timer-idlestart"></a>

### 234. Timeout objects have no _idleStart field

1 file. Category `c`. The property-presence check returns false. The native-compatible Node timer metadata is missing.

Test subject `setTimeout returns Timeout object with _idleStart property`. Throwing frame `at <anonymous> (/bun/test/regression/issue/25639.test.ts:13:35)`.

Observed diagnostic:

```text
Expected: true
Received: false
```

Suspected implementation [crates/bunwasm-runtime/src/js/bootstrap.js:267](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/bootstrap.js#L267). Reproducer `suite quickjs 'regression/issue/25639.test.ts'`.

<a id="cause-timer-promisify"></a>

### 235. Timer functions lack util.promisify.custom hooks

1 file. Category `c`. Reading fn[promisify.custom].name throws because the per-timer custom function is undefined. This is earlier than the warmed property-read behavior.

Test subject `util.promisify.custom stays per timer once the property read is warm`. Throwing frame `at <anonymous> (/bun/test/regression/issue/44275.test.ts:36:18)`.

Observed diagnostic:

```text
- ""
+ "1 | const { promisify } = require("node:util");
+ 2 |        const sym = promisify.custom;
+ 3 |        const read = fn => fn[sym].name;
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:250](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L250). Reproducer `suite quickjs 'regression/issue/44275.test.ts'`.

<a id="cause-cjs-dynamic-import"></a>

### 236. Top-level await in CJS dynamic-import fixtures is not lowered correctly

1 file. Category `d`. A .cjs file containing await import bun:test reaches QuickJS with unexpected top-level await and fails expecting semicolon. Collection fails before test #1 runs.

Test subject `bun test > works with cjs dynamic import`. Throwing frame `at <anonymous> (/bun/test/cli/test/bun-test.test.ts:224:20)`.

Observed diagnostic:

```text
Expected to contain: "test #1"
Received: "\ntest.test.cjs:\n\n# Unhandled error between tests\n-------------------------------\n1 | \n2 |         const { test, expect } = await import(\"bun:test\");\n                                           ^\nSynta
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:362](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L362). Reproducer `suite quickjs 'cli/test/bun-test.test.ts'`.

<a id="cause-unknown-builtin-code"></a>

### 237. Unknown node builtins use ERR_MODULE_NOT_FOUND instead of ERR_UNKNOWN_BUILTIN_MODULE

1 file. Category `c`. Dynamic CJS import reaches the rejection handler, but its stable public code is wrong. Match the Node code without copying an engine-specific message.

Test subject `dynamic import of non-existent node: module in CJS rejects at runtime with correct error`. Throwing frame `at <anonymous> (/bun/test/regression/issue/25707.test.ts:111:25)`.

Observed diagnostic:

```text
Expected: "caught: ERR_UNKNOWN_BUILTIN_MODULE"
Received: "caught: ERR_MODULE_NOT_FOUND"
```

Suspected implementation [crates/bunwasm-runtime/src/modules.rs:83](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/modules.rs#L83). Reproducer `suite quickjs 'regression/issue/25707.test.ts'`.

<a id="cause-worker-tla-exit"></a>

### 238. Unsettled worker top-level await exits 0 instead of 13

1 file. Category `c`. The worker lifecycle adapter publishes success while the entry module remains unresolved.

Test subject `worker with an unsettled top-level await exits with code 13`. Throwing frame `at <anonymous> (/bun/test/js/node/worker_threads/worker-top-level-await.test.ts:10:20)`.

Observed diagnostic:

```text
Expected: 13
Received: 0
```

Suspected implementation [crates/bunwasm-runtime/src/js/worker_threads.ts:526](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/worker_threads.ts#L526). Reproducer `suite quickjs 'js/node/worker_threads/worker-top-level-await.test.ts'`.

<a id="cause-spawn-sync-signal-code"></a>

### 239. Unsignalled Bun.spawnSync returns signalCode null instead of undefined

1 file. Category `c`. All four raw failures expect signalCode undefined and receive null. The normal spawnSync return supplies null for an unsignalled child. Empty stderr satisfies expect.any(String), as matchesConstructor explicitly accepts primitive strings. This result-shape assertion establishes no stack-exhaustion or stdio initialization failure.

Test subject `process.stdin lazy init near stack limit does not assert`. Throwing frame `at <anonymous> (/bun/test/js/node/process/process-stdio-stack-overflow.test.ts:16:55)`.

Observed diagnostic:

```text
-   "signalCode": undefined,
-   "stderr": Any<String>,
+   "signalCode": null,
+   "stderr": "",
```

Suspected implementation [crates/bunwasm-runtime/src/js/spawn.js:321](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/spawn.js#L321). Reproducer `suite quickjs 'js/node/process/process-stdio-stack-overflow.test.ts'`.

<a id="cause-url-file-slashes"></a>

### 240. URL parsing collapses repeated leading file path slashes

1 file. Category `c`. The expected pathname ///bar// becomes /bar//. Inspect file-URL path normalization rather than generic object equality.

Test subject `urlPathRepeatedSlashes`. Throwing frame `at ::bunternal:: (/bun/test/js/deno/harness.ts:105:20)`.

Observed diagnostic:

```text
Expected: "///bar//"
Received: "/bar//"
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:292](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L292). Reproducer `suite quickjs 'js/deno/url/url.test.ts'`.

<a id="cause-blob-url"></a>

### 241. URL.createObjectURL is absent

1 file. Category `d`. Worker fixture setup cannot create a blob URL. This is earlier than worker execution or transfer-list behavior.

Test subject `self.postMessage transfer list > postMessage(msg, [ArrayBuffer]) transfers and detaches the buffer`. Throwing frame `at roundtrip (/bun/test/js/web/workers/worker-postmessage-transfer.test.ts:17:21)`.

Observed diagnostic:

```text
const url = URL.createObjectURL(new Blob([body]));                          ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:292](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L292). Reproducer `suite quickjs 'js/web/workers/worker-postmessage-transfer.test.ts'`.

<a id="cause-urlsearchparams-arity"></a>

### 242. URLSearchParams methods do not validate missing arguments

1 file. Category `c`. The first no-argument method call returns normally, producing the fixture sentinel 1 instead of TypeError sentinel 2. delete, get, getAll, has, forEach, append and set share the missing arity checks.

Test subject `urlSearchParamsAppendArgumentsCheck`. Throwing frame `at ::bunternal:: (/bun/test/js/deno/harness.ts:105:20)`.

Observed diagnostic:

```text
Expected: 2
Received: 1
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:187](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L187). Reproducer `suite quickjs 'js/deno/url/urlsearchparams.test.ts'`.

<a id="cause-urlsearchparams-json"></a>

### 243. URLSearchParams.toJSON is absent

1 file. Category `c`. The large-parameter fixture calls an absent method instead of receiving the expected property object.

Test subject `URLSearchParams > does not crash when calling .toJSON() on a URLSearchParams object with a large number of properties`. Throwing frame `at <anonymous> (/bun/test/js/web/html/URLSearchParams.test.ts:87:19)`.

Observed diagnostic:

```text
expect(params.toJSON()).toEqual(props);                        ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/web.js:187](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/web.js#L187). Reproducer `suite quickjs 'js/web/html/URLSearchParams.test.ts'`.

<a id="cause-custom-inspect"></a>

### 244. util.inspect passes a different function identity to inspect.custom

1 file. Category `c`. Both values print as [Function: inspect], but Object.is is false. This is callback identity, not an inspect string-format mismatch.

Test subject `util.inspect calls inspect.custom with valid options`. Throwing frame `at [nodejs.util.inspect.custom] (/bun/test/js/node/util/custom-inspect.test.js:81:25)`.

Observed diagnostic:

```text
Expected: [Function: inspect]
Received: [Function: inspect]
```

Suspected implementation [crates/bunwasm-runtime/src/js/inspect.js:2719](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/inspect.js#L2719). Reproducer `suite quickjs 'js/node/util/custom-inspect.test.js'`.

<a id="cause-vm-proxy-validation"></a>

### 245. vm.compileFunction accepts Proxy parameter lists

1 file. Category `c`. The process.setgroups Proxy check passes. The first failing assertion is vm.compileFunction with Proxy params, which returns a function instead of throwing. Its implementation joins params without the expected validation and ignores contextExtensions. No group-management syscall is implicated.

Test subject `isArray + Proxy crash fixes > vm.compileFunction throws for Proxy params (no crash)`. Throwing frame `at <anonymous> (/bun/test/regression/issue/isArray-proxy-crash.test.ts:57:69)`.

Observed diagnostic:

```text
Received function did not throw
Received value: [Function]
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:322](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L322). Reproducer `suite quickjs 'regression/issue/isArray-proxy-crash.test.ts'`.

<a id="cause-ws-protocol-error"></a>

### 246. WebSocket handshake rejection omits Mismatch client protocol close reason

1 file. Category `c`. The close reason is empty after rejecting multiple server subprotocols. The fixture expects Mismatch client protocol.

Test subject `WebSocket strict RFC 6455 subprotocol handling > should reject multiple comma-separated protocols`. Throwing frame `at <anonymous> (/bun/test/js/web/websocket/websocket-subprotocol-strict.test.ts:76:28)`.

Observed diagnostic:

```text
Expected: "Mismatch client protocol"
Received: ""
```

Suspected implementation [crates/bunwasm-runtime/src/js/websocket.js:8](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/websocket.js#L8). Reproducer `suite quickjs 'js/web/websocket/websocket-subprotocol-strict.test.ts'`.

<a id="cause-worker-terminate-clone"></a>

### 247. Worker data cannot share the fixture's SharedArrayBuffer

1 file. Category `a`. Every termination case passes an Int32Array over a SharedArrayBuffer in workerData. The codec rejects that buffer before starting the worker. Guest stores have independent linear memories and the host worker protocol has no shared-JS-buffer identity or shared-backing-store handle. The private network SharedArrayBuffer ring is not a guest workerData transfer API. This establishes a current host-ABI gap, not sixteen termination failures.

Test subject `terminate() at every native→JS entry point > timers`. Throwing frame `at <anonymous> (/bun/test/js/web/workers/worker-terminate-funnels.test.ts:40:91)`.

Observed diagnostic:

```text
-   "exitCode": 0,
-   "stdout": "ok 16",
+   "exitCode": 1,
+   "stdout": "FAIL
+ setTimeout [armed]: host error:     at cloneError (bun-wasm:worker_codec:16:77)
```

Suspected implementation [crates/bunwasm-runtime/src/js/worker_codec.ts:66](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/worker_codec.ts#L66). Reproducer `suite quickjs 'js/web/workers/worker-terminate-funnels.test.ts'`.

<a id="cause-transfer-error"></a>

### 248. Worker transfer validation throws DOMException instead of TypeError

1 file. Category `c`. An invalid transfer entry is rejected, but the thrown constructor is DOMException. Match the Node Worker API's TypeError contract while keeping transfer validation before detachment.

Test subject `an invalid transferList entry throws before anything is detached`. Throwing frame `at <anonymous> (/bun/test/js/node/worker_threads/worker-transfer-list.test.ts:13:8)`.

Observed diagnostic:

```text
Expected constructor: TypeError
Received constructor: DOMException
Received message: "Invalid transferable object"
```

Suspected implementation [crates/bunwasm-runtime/src/js/worker_codec.ts:27](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/worker_codec.ts#L27). Reproducer `suite quickjs 'js/node/worker_threads/worker-transfer-list.test.ts'`.

<a id="cause-zlib-flush"></a>

### 249. zlib transform streams have no flush method

1 file. Category `d`. The gzip/gunzip fixture stops at target.flush rather than an incorrect compressed byte count.

Test subject `Test createGzip and createGunzip`. Throwing frame `at <anonymous> (/bun/test/js/node/zlib/bytesWritten.test.ts:14:18)`.

Observed diagnostic:

```text
target.flush(() => write());                       ^
TypeError: not a function
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:607](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L607). Reproducer `suite quickjs 'js/node/zlib/bytesWritten.test.ts'`.

<a id="cause-zlib-native-handle"></a>

### 250. zlib._handle.writeSync is absent

1 file. Category `d`. The fixture calls _handle.writeSync before its bounds assertion, but that private object is absent. Compression itself already runs through portable Rust natives. Providing the handle contract and its buffer/lifetime rules is implementation work that can also support upstream Node/Bun zlib code. The raw record establishes no host impossibility or sufficient cost reason to exclude it.

Test subject `zlib native handle bounds checking > writeSync rejects in_len exceeding input buffer`. Throwing frame `at <anonymous> (/bun/test/js/node/zlib/zlib-handle-bounds-check.test.ts:23:8)`.

Observed diagnostic:

```text
Expected pattern: /exceeds input buffer length/
Received message: "cannot read property 'writeSync' of undefined"
```

Suspected implementation [crates/bunwasm-runtime/src/js/builtins.js:607](https://github.com/ShaulLavo/bun-wasm/blob/6e93c80c6f9bccc879990bedb999c3efdcd3166f/crates/bunwasm-runtime/src/js/builtins.js#L607). Reproducer `suite quickjs 'js/node/zlib/zlib-handle-bounds-check.test.ts'`.


### Selected reproductions on 2026-10-17

The fresh build reran 53 representative files on QuickJS and 14 comparison files on each of JSC and browser through the suite queue. Every selected file retained its baseline pass/fail status, timeout status, and observed counters. These are diagnostic reproductions of failures, including the expected passing controls on other engines.

| Engine | Selected files | Fully passing before → rerun | Observed passes before → rerun | Observed failures before → rerun | File timeouts before → rerun |
|---|---|---|---|---|---|
| quickjs | 53 | 0 → 0 | 643 → 643 | 1286 → 1286 | 2 → 2 |
| jsc | 14 | 6 → 6 | 87 → 87 | 13 → 13 | 0 → 0 |
| browser | 14 | 11 → 11 | 93 → 93 | 7 → 7 | 0 → 0 |


The runner hash, suite commit, root dependency hash, 15-second file deadline, and 2-second test deadline match the baseline. Fresh wasm and launcher builds have their own recorded hashes. The frozen supplemental install contains 5,114 hashed files versus the original run's 2,483, so its dependency provenance differs. The immutable baseline remains the counting authority.

The exact selected lists, per-file logs, provenance, and complete counter comparison are retained as `selected-files.txt`, `engine-files.txt`, `selected-logs/`, `*-selected.json`, and `selected-comparison.json` in the analysis report directory. The command was:

```bash
export PATH=$HOME/.local/share/mise/shims:$PATH
bash /work/tmp/wave-heavy/run.sh --class suite "bun-wasm root cause samples" -- \
  env PATH="$PATH" bash /work/reports/bun-wasm-triage-causes-2026-10-17/rerun.sh
```


### Evidence and coverage limits

The complete baseline JSON and per-file logs are in `/work/reports/bun-wasm-main-2026-10-17/suite/` and `suite-logs/`. This analysis retains the rule table, exact membership, representative failure blocks, generator, selected reruns, and validation output in `/work/reports/bun-wasm-triage-causes-2026-10-17/`. The coordinator owns removal after accepting the triage. Run `node /work/reports/bun-wasm-triage-causes-2026-10-17/build-triage.ts` from a checkout of this PR to regenerate and check the membership.

Received values, test subjects, and stacks were read from complete logs. The raw JSON's `first_errors` can include diagnostics printed by child programs, even expected errors from a passing control. For example, the JSX mismatch child in `regression/issue/14477/14477.test.ts` correctly rejects invalid JSX; the actual failing assertion later encounters the absent `Bun.Transpiler`. Counts therefore identify a demonstrated blocker in a file, not a promise that every first log line is an unexpected error. Snapshot files can expose version, path, reporter, hook, and formatter differences together; one assigned cause does not erase the others.

The remaining 279 files in the selection are listed here without invented root causes. They are outside the six requested buckets. In particular, an empty log or a timeout that passes on another engine is evidence of a differential outcome, not enough evidence to label a missing API, a deadlock, or a leak. Existing provisional subsystem assignments remain available in `failures.tsv`.

<details>
<summary>Files outside the six buckets still needing a concrete diagnosis</summary>

| File | First recorded diagnostic |
|---|---|
| `bake/hmr-socket-protocol.test.ts` | `  ^ this test timed out after 2000ms.` |
| `bundler/bun-build-compile-wasm.test.ts` | `<no error>` |
| `bundler/resolver/cache-invalidation.test.ts` | `<no error>` |
| `bundler/transpiler/react-compiler-fixtures-run.test.ts` | `<no error>` |
| `bundler/transpiler/react-compiler-fixtures.test.ts` | `<no error>` |
| `cli/bunfig-test-options.test.ts` | `error: expect(received).not.toEqual(expected)` |
| `cli/inspect/inspect.test.ts` | `error: expect(received).toMatchObject(expected)` |
| `cli/inspect/test-reporter.test.ts` | `error: Unix sockets and TLS sockets are not supported in bun-wasm` |
| `cli/install/bun-audit.test.ts` | `ERR: error: bun audit is not supported in bun-wasm` |
| `cli/install/bun-dedupe.test.ts` | `error: expect(received).toStrictEqual(expected)` |
| `cli/install/bun-install-env-file.test.ts` | `error: expect(received).toBeGreaterThan(expected)` |
| `cli/install/bun-install-proxy.test.ts` | `error: A functional 'docker' is required in CI for some tests.` |
| `cli/install/bun-install-tarball-integrity.test.ts` | `error: test expects a function as the second argument` |
| `cli/install/bun-pm-cache-pack.test.ts` | `TypeError: cannot convert BigInt to number` |
| `cli/install/bun-publish.test.ts` | `error: Failed to create user publish-tests: 500 {"error":"Internal Server Error"}` |
| `cli/install/config-precedence.test.ts` | `error: Failed to create user config-precedence: 500 {"error":"Internal Server Error"}` |
| `cli/install/hoist.test.ts` | `error: expect(received).not.toContain(expected)` |
| `cli/install/public-hoist-pattern.test.ts` | `error: expect(received).toMatch(expected)` |
| `cli/run/as-node.test.ts` | `error: error: Module not found "node"` |
| `cli/run/commonjs-no-export.test.ts` | `error: Module not found "--bun"` |
| `cli/run/crash-report-command-char.test.ts` | `error: expect(received).not.toBeNull()` |
| `cli/run/empty-file.test.ts` | `error: expect(received).toBeEmpty()` |
| `cli/run/env.test.ts` | `SyntaxError: Could not find export 'parseEnv' in module 'node:util'` |
| `cli/run/esm-defineProperty.test.ts` | `error: 4` |
| `cli/run/if-present.test.ts` | `error: expect(received).toMatch(expected)` |
| `cli/run/markdown-entrypoint.test.ts` | `error: expect(received).toMatchSnapshot(expected)` |
| `cli/run/multi-run.test.ts` | `error: expect(received).toMatch(expected)` |
| `cli/run/require-and-import-trailing.test.ts` | `SyntaxError: Expected property name or '}' in JSON at position 13 (line 3 column 7)` |
| `cli/run/require-cache.test.ts` | `ReferenceError: require is not defined` |
| `cli/run/run-cjs.test.ts` | `error: expect(received).toMatchObject(expected)` |
| `cli/run/run-extensionless.test.ts` | `error: Expected ";" but found ":"` |
| `cli/run/run-process-env.test.ts` | `error: error: Module not found "start:dev"` |
| `cli/run/run-quote.test.ts` | `error: error: Module not found "test"` |
| `cli/run/run-shell.test.ts` | `error: Expected ";" but found "wah"` |
| `cli/run/run_command.test.ts` | `error: expect(received).toMatch(expected)` |
| `cli/run/transpiler-cache.test.ts` | `error: expect(received).toBeTrue()` |
| `cli/test/concurrent-test-glob.test.ts` | `error: expect(received).toBeGreaterThan(expected)` |
| `cli/test/coverage.test.ts` | `error: expect(received).toBeUndefined()` |
| `cli/test/parallel.test.ts` | `error: expect(received).not.toContain(expected)` |
| `cli/test/path-ignore-patterns.test.ts` | `error: expect(received).not.toContain(expected)` |
| `cli/test/test-randomize.test.ts` | `error: expect(received).toBeFinite()` |
| `cli/update_interactive_install.test.ts` | `error: expect(received).not.toContain(expected)` |
| `cli/update_interactive_snapshots.test.ts` | `error: Child process pipe is closed` |
| `integration/bun-types/bun-types.test.ts` | `error: Cannot find module '../../../' from '/bun/test/integration/bun-types/bun-types.test.ts'` |
| `internal/sigaction-layout.test.ts` | `error: expect(received).toBeFunction()` |
| `internal/source-lints/host-export-callers.test.ts` | `error: expect(received).toBeGreaterThan(expected)` |
| `js/bun/bun-object/deep-equals-temporal.test.ts` | `RangeError: Offset +02:00 is invalid for 2024-06-15T12:34:56 in Europe/Berlin` |
| `js/bun/bun-object/write.spec.ts` | `error: Unexpected return from matcher function 'toThrowWithCodeAsync'.` |
| `js/bun/console/bun-inspect-table.test.ts` | `error: expect(received).toMatchSnapshot(expected)` |
| `js/bun/console/console-table.test.ts` | `error: expect(received).toThrow()` |
| `js/bun/crypto/wpt-webcrypto.generateKey.test.ts` | `<no error>` |
| `js/bun/css/color.test.ts` | `SyntaxError: Could not find export 'color' in module 'bun'` |
| `js/bun/glob/leak.test.ts` | `<no error>` |
| `js/bun/glob/proto.test.ts` | `<no error>` |
| `js/bun/image/image-adversarial.test.ts` | `TypeError: cannot read property 'backend' of undefined` |
| `js/bun/ini/ini.test.ts` | `TypeError: Cannot convert undefined or null to object` |
| `js/bun/jsc/domjit.test.ts` | `SyntaxError: Could not find export 'read' in module 'bun:ffi'` |
| `js/bun/jsc/heapStats-mimalloc.test.ts` | `error: expect(received).toBeDefined()` |
| `js/bun/jsc/shadow.test.js` | `ReferenceError: ShadowRealm is not defined` |
| `js/bun/jsc/webkit-upgrade-3722912f.test.ts` | `RangeError: Maximum call stack size exceeded` |
| `js/bun/md/md-react.test.ts` | `TypeError: cannot read property 'react' of undefined` |
| `js/bun/md/md-render-callback.test.ts` | `TypeError: cannot read property 'render' of undefined` |
| `js/bun/namespace-prototype-pollution.test.ts` | `TypeError: object is not extensible` |
| `js/bun/perf_hooks/histogram.test.ts` | `AssertionError: Expected values to be strictly equal:` |
| `js/bun/repl/repl.test.ts` | `error: Child process pipe is closed` |
| `js/bun/resolve/build-error.test.ts` | `error: Expected BuildMessage, got BuildError` |
| `js/bun/resolve/bun-lock.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `js/bun/resolve/esModule.test.ts` | `TypeError: object is not extensible` |
| `js/bun/resolve/import-meta-resolve.test.mjs` | `error: Cannot find module './haha.mjs' from '/bun/test/js/bun/resolve/import-meta-resolve.test.mjs'` |
| `js/bun/resolve/import-query.test.ts` | `error: Cannot find module './import-query-fixture.ts?query' from '/bun/test/js/bun/resolve/import-query.test.ts'` |
| `js/bun/resolve/require-esm-evaluating-cycle.test.ts` | `bun-wasm: bun.wasm trapped: error while executing at wasm backtrace:` |
| `js/bun/resolve/resolve-ts.test.ts` | `error: Unexpected value` |
| `js/bun/resolve/resolve.test.ts` | `error: Cannot find module '#foo/wildcard.js' from '/bun/test/js/bun/resolve/resolve-test.js'` |
| `js/bun/resolve/xml/xml.test.js` | `BuildError: Unexpected <` |
| `js/bun/s3/s3.leak.test.ts` | `error: Secret not found: S3_R2_ACCESS_KEY` |
| `js/bun/secrets.test.ts` | `SyntaxError: Could not find export 'read' in module 'bun:ffi'` |
| `js/bun/spawn/readablestream-helpers.test.ts` | `error: expect(received).toThrowErrorMatchingInlineSnapshot()` |
| `js/bun/spawn/spawn-socketpair-shutdown.test.ts` | `  ^ this test timed out after 2000ms.` |
| `js/bun/spawn/spawn-stdin-destroy.test.ts` | `error: test` |
| `js/bun/spawn/spawn-streaming-stdin.test.ts` | `<no error>` |
| `js/bun/spawn/spawn.test.ts` | `error: expect(received).toHaveLength(expected)` |
| `js/bun/spawn/spawnSync.test.ts` | `error: expect(received).toThrowErrorMatchingInlineSnapshot()` |
| `js/bun/spawn/spawn_waiter_thread.test.ts` | `TypeError: cannot read property 'cpuTime' of undefined` |
| `js/bun/symbols.test.ts` | `error: objdump executable not found. Please install it.` |
| `js/bun/test/expect-type-doctest.test.ts` | `SyntaxError: Could not find export 'expectTypeOf' in module 'bun:test'` |
| `js/bun/test/expect-type-global.test.ts` | `ReferenceError: expectTypeOf is not defined` |
| `js/bun/test/expect-type.test.ts` | `SyntaxError: Could not find export 'expectTypeOf' in module 'bun:test'` |
| `js/bun/test/jest-extended.test.js` | `error: expect(received).toBeTypeOf()` |
| `js/bun/test/mock-disposable.test.ts` | `TypeError: value is not disposable` |
| `js/bun/test/only-inside-only.test.ts` | `error: expect(received).not.toContain(expected)` |
| `js/bun/test/spyMatchers.test.ts` | `error: expect(received).toThrow()` |
| `js/bun/test/stack.test.ts` | `error: Expected stdout to be "{\n  \"line\": 3,\n  \"column\": 17,\n  \"originalLine\": 1,\n  \"originalColumn\": 18\n}" but got "{}"` |
| `js/bun/udp/dgram.test.ts` | `TypeError: cannot read property 'internal/dgram' of undefined` |
| `js/bun/util/bun-cryptohasher.test.ts` | `TypeError: cannot read property 'name' of undefined` |
| `js/bun/util/bun-file-fd-read.test.ts` | `TypeError: cannot read property 'startsWith' of null` |
| `js/bun/util/bun-file-windows.test.ts` | `<no error>` |
| `js/bun/util/bun-main.test.ts` | `TypeError: no setter for property` |
| `js/bun/util/csrf.test.ts` | `SyntaxError: Could not find export 'CSRF' in module 'bun'` |
| `js/bun/util/fuzzy-wuzzy.test.ts` | `TypeError: cannot read property 'name' of undefined` |
| `js/bun/util/index-of-line.test.ts` | `SyntaxError: Could not find export 'indexOfLine' in module 'bun'` |
| `js/bun/util/inspect.test.js` | `BuildError: Unexpected <` |
| `js/bun/util/password.test.ts` | `SyntaxError: Could not find export 'password' in module 'bun'` |
| `js/bun/util/randomUUIDv7.test.ts` | `error: expect(received).toMatch(expected)` |
| `js/bun/util/sleepSync.test.ts` | `error: expect(received).toThrow()` |
| `js/bun/util/stringWidth.test.ts` | `error: expected undefined to have npm string width 0 but got 9` |
| `js/bun/util/text-loader.test.ts` | `error: Cannot find module './text-loader-fixture-text-file.txt?0' from '/bun/test/js/bun/util/text-loader-fixture-dynamic-import-stress.ts'` |
| `js/bun/util/unsafe.test.js` | `error: Bun.unsafe.arrayBufferToString is not supported in bun-wasm: zero-copy strings are not exposed` |
| `js/bun/util/v8-heap-snapshot.test.ts` | `error: "generate-string" fixture exited with code 1` |
| `js/bun/wasm/compile-rss.test.ts` | `  ^ this test timed out after 2000ms.` |
| `js/bun/xml/xml-test-suite.test.ts` | `SyntaxError: Could not find export 'XML' in module 'bun'` |
| `js/bun/xml/xml.test.ts` | `SyntaxError: Could not find export 'XML' in module 'bun'` |
| `js/deno/event/event.test.ts` | `error: expect(received).toBeTruthy()` |
| `js/junit-reporter/junit.test.js` | `<no error>` |
| `js/node/assert/assert-typedarray-deepequal.test.ts` | `error: expect(received).toBeInstanceOf(expected)` |
| `js/node/assert/deep-equal.test.ts` | `error: expect(received).toBeNull()` |
| `js/node/async_hooks/EventEmitterAsyncResource.test.ts` | `SyntaxError: Could not find export 'EventEmitterAsyncResource' in module 'node:events'` |
| `js/node/async_hooks/async_hooks.node.test.ts` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/buffer-indexOf-detach.test.ts` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/buffer-resolveObjectURL.test.ts` | `SyntaxError: Could not find export 'Blob' in module 'node:buffer'` |
| `js/node/buffer.test.js` | `error: expect(received).toBeFalse()` |
| `js/node/child_process/child_process-node.test.js` | `AssertionError: Expected values to be strictly deep-equal:` |
| `js/node/cluster.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `js/node/dgram/node-dgram.test.js` | `SyntaxError: Unexpected end of JSON input` |
| `js/node/disallow-code-generation-from-strings.test.ts` | `SyntaxError: Unexpected end of JSON input` |
| `js/node/dns/dns-lookup-keepalive.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `js/node/fs/cp-symlink-target.test.ts` | `<no error>` |
| `js/node/fs/fs-birthtime-linux.test.ts` | `error: expect(received).toBeGreaterThan(expected)` |
| `js/node/fs/fs-leak.test.js` | `<no error>` |
| `js/node/fs/fs-promises-writeFile-async-iterator.test.ts` | `TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received an instance of Object` |
| `js/node/fs/fs-read-buffer-before-offset.test.ts` | `AssertionError: Expected values to be strictly deep-equal:` |
| `js/node/fs/fs-stats-constructor.test.ts` | `error: expect(received).toMatchObject(expected)` |
| `js/node/fs/fs-write-offset-bound.test.ts` | `AssertionError: Missing expected exception (RangeError).` |
| `js/node/inspector/inspector-profiler.test.ts` | `error: No such built-in module: node:inspector/promises` |
| `js/node/inspector/inspector.test.ts` | `error: inspector.url is not supported in bun-wasm: no debugger` |
| `js/node/missing-module.test.js` | `AssertionError: Expected values to be strictly deep-equal:` |
| `js/node/module/node-module-module.test.js` | `error: expect(received).toHaveLength(expected)` |
| `js/node/module/require-extensions.test.ts` | `error: expect(received).toBeFunction()` |
| `js/node/module/sourcemap-simd.test.ts` | `error: expect(received).toBeNull()` |
| `js/node/module/sourcemap.test.js` | `error: expect(received).toThrowErrorMatchingInlineSnapshot()` |
| `js/node/nodettywrap.test.ts` | `error: No such module: tty_wrap` |
| `js/node/path/basename.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/path/dirname.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/path/extname.test.js` | `AssertionError: ` |
| `js/node/path/join.test.js` | `AssertionError: ` |
| `js/node/path/normalize.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/path/parse-format.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/path/relative.test.js` | `AssertionError: ` |
| `js/node/path/to-namespaced-path.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/process-binding.test.ts` | `error: No such module: constants` |
| `js/node/process/call-constructor.test.js` | `TypeError: not an object` |
| `js/node/process/process-signal-listener-count.test.ts` | `bun-wasm: bun.wasm trapped: error while executing at wasm backtrace:` |
| `js/node/process/process.test.js` | `error: process.env is not an object` |
| `js/node/process/stdin/stdin-fixtures.test.ts` | `error: [/usr/local/bin/bun] Not all stdin was sent. Unsent: ["abc\n","pause\n","def\n"]` |
| `js/node/quic/quic-endpoint.test.ts` | `error: No such built-in module: node:quic` |
| `js/node/quic/quic-sni.test.ts` | `error: No such built-in module: node:quic` |
| `js/node/quic/quic-stream.test.ts` | `error: No such built-in module: node:quic` |
| `js/node/readline/getStringWidth.test.ts` | `TypeError: Cannot convert undefined or null to object` |
| `js/node/readline/readline_promises.node.test.ts` | `error: expect(received).toMatch(expected)` |
| `js/node/readline/stdin_fell_asleep.test.ts` | `  ^ this test timed out after 2000ms.` |
| `js/node/string_decoder/string-decoder.test.js` | `TypeError: class constructors must be invoked with 'new'` |
| `js/node/timers.promises/timers.promises.test.ts` | `error: expect(received).rejects.toThrow(expected)` |
| `js/node/timers/node-timers.test.ts` | `TypeError: The "callback" argument must be of type function. Received type number (1)` |
| `js/node/url/url-canParse-whatwg.test.js` | `AssertionError: Missing expected exception (TypeError).` |
| `js/node/url/url-fileurltopathbuffer.test.ts` | `SyntaxError: Could not find export 'fileURLToPathBuffer' in module 'node:url'` |
| `js/node/url/url-format-whatwg.test.js` | `AssertionError: Missing expected exception (TypeError).` |
| `js/node/url/url-format.test.js` | `AssertionError: wonky format(http://google.com" onload="alert(42)/) == http://google.com/%22%20onload=%22alert(42)/` |
| `js/node/url/url-parse-format.test.js` | `AssertionError: parsing http:\\evil-phisher\foo.html#h\a\s\h and expected Url {` |
| `js/node/url/url-parse-ipv6.test.ts` | `error: expect(received).toThrowError(expected)` |
| `js/node/url/url-parse-query.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/url/url-relative.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/util/bun-inspect.test.ts` | `error: expect(received).not.toBe(expected)` |
| `js/node/util/mime-api.test.ts` | `SyntaxError: Could not find export 'MIMEParams' in module 'node:util'` |
| `js/node/util/node-inspect-tests/internal-inspect.test.js` | `error: Error message` |
| `js/node/util/node-inspect-tests/parallel/util-format.test.js` | `AssertionError: Expected "Error: foo` |
| `js/node/util/node-inspect-tests/parallel/util-inspect-proxy.test.js` | `error: get: Symbol(nodejs.util.inspect.custom)` |
| `js/node/util/node-inspect-tests/parallel/util-inspect.test.js` | `AssertionError: Expected values to be strictly equal:` |
| `js/node/util/test-aborted.test.ts` | `SyntaxError: Could not find export 'aborted' in module 'node:util'` |
| `js/node/v8/v8-module.test.ts` | `SyntaxError: Could not find export 'GCProfiler' in module 'node:v8'` |
| `js/node/vm/vm-sourceUrl.test.ts` | `error: expect(received).toMatchSnapshot(expected)` |
| `js/node/vm/vm.test.ts` | `SyntaxError: Could not find export 'constants' in module 'node:vm'` |
| `js/node/watch/fs.watch.deadlock.test.ts` | `error: expect(received).toStartWith(expected)` |
| `js/node/watch/fs.watch.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `js/node/worker_threads/15787.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `js/node/worker_threads/worker_threads.test.ts` | `SyntaxError: Could not find export 'markAsUncloneable' in module 'node:worker_threads'` |
| `js/node/zlib/deflate-streaming.test.ts` | `Total data received: 524288 bytes` |
| `js/third_party/es-module-lexer/es-module-lexer.test.ts` | `SyntaxError: import.meta only valid in module code` |
| `js/third_party/esbuild/esbuild-child_process.test.ts` | `error: Unsupported platform: linux wasm32 LE` |
| `js/third_party/express/express.json.test.ts` | `error: expected 200 "OK", got 400 "Bad Request"` |
| `js/third_party/express/express.text.test.ts` | `error: expected 200 "OK", got 400 "Bad Request"` |
| `js/third_party/express/res.location.test.ts` | `error: cannot GET /?q=https%3A%2F%2Fgoogle.com'.bb.com%2F1.html (400)` |
| `js/third_party/express/res.sendFile.test.ts` | `error: expected body '<!DOCTYPE html>\n' +` |
| `js/third_party/grpc-js/test-channelz.test.ts` | `TypeError: cannot read property 'loadPackageDefinition' of undefined` |
| `js/third_party/grpc-js/test-client.test.ts` | `TypeError: cannot read property 'credentials' of undefined` |
| `js/third_party/grpc-js/test-logging.test.ts` | `TypeError: cannot read property 'setLogger' of undefined` |
| `js/third_party/grpc-js/test-outlier-detection.test.ts` | `TypeError: cannot read property 'Server' of undefined` |
| `js/third_party/grpc-js/test-pick-first.test.ts` | `TypeError: cannot read property 'connectivityState' of undefined` |
| `js/third_party/jsonwebtoken/claim-exp.test.js` | `  ^ this test timed out after 2000ms, before its done callback was called. If a done callback was not intended, remove the last parameter from the test callback function` |
| `js/third_party/jsonwebtoken/claim-iat.test.js` | `  ^ this test timed out after 2000ms, before its done callback was called. If a done callback was not intended, remove the last parameter from the test callback function` |
| `js/third_party/jsonwebtoken/claim-nbf.test.js` | `  ^ this test timed out after 2000ms, before its done callback was called. If a done callback was not intended, remove the last parameter from the test callback function` |
| `js/third_party/jsonwebtoken/jwt.asymmetric_signing.test.js` | `error: secretOrPrivateKey must be an asymmetric key when using ES256` |
| `js/third_party/jsonwebtoken/option-complete.test.js` | `error: expect(received).toBeNull()` |
| `js/third_party/jsonwebtoken/schema.test.js` | `error: secretOrPrivateKey must be an asymmetric key when using ES256` |
| `js/third_party/jsonwebtoken/validateAsymmetricKey.test.js` | `error: Failed to read asymmetric key` |
| `js/third_party/jsonwebtoken/verify.test.js` | `<no error>` |
| `js/third_party/msw/msw.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `js/third_party/nodemailer/nodemailer.test.ts` | `error: Secret not found: SMTP_MAILGUN_PASS` |
| `js/third_party/pino/pino.test.js` | `error: expect(received).toBeEmpty()` |
| `js/third_party/st/st.test.ts` | `error: expect(received).toBeEmpty()` |
| `js/third_party/vitest/vitest.test.ts` | `error: test/node_modules has vitest <missing> but test/package.json requires 4.1.9. Run 'bun install' in test/ before running this test.` |
| `js/web/atomics.test.ts` | `ReferenceError: Atomics is not defined` |
| `js/web/console/console-log.test.ts` | `TypeError: expected depth to be greater than or equal to 0, got -1` |
| `js/web/encoding/text-decoder-cjk.test.ts` | `RangeError: Unsupported encoding label "shift_jis"` |
| `js/web/encoding/text-decoder-single-byte.test.ts` | `RangeError: Unsupported encoding label "ibm866"` |
| `js/web/encoding/text-decoder-wpt.test.ts` | `RangeError: Unsupported encoding label "IBM866"` |
| `js/web/encoding/text-decoder.test.js` | `TypeError: cannot read property 'isUTF16String' of undefined` |
| `js/web/fetch/fetch-abort-queued.test.ts` | `  ^ this test timed out after 2000ms.` |
| `js/web/html/FormData-file-error-leak.test.ts` | `SyntaxError: Unexpected end of JSON input` |
| `js/web/html/FormData-multipart-serialization.test.ts` | `error: expect(received).toMatch(expected)` |
| `js/web/html/FormData.test.ts` | `error: expect(received).toBeUndefined()` |
| `js/web/intl/intl.test.ts` | `TypeError: cannot read property 'supportedLocalesOf' of undefined` |
| `js/web/request/request-method-getter.test.ts` | `error: expect(received).toBeLessThan(expected)` |
| `js/web/request/request.test.ts` | `error: expect(received).not.toBe(expected)` |
| `js/web/temporal/temporal.test.ts` | `error: expect(received).toMatchObject(expected)` |
| `js/web/timers/setImmediate2.test.ts` | `<no error>` |
| `js/web/timers/setInterval.test.js` | `error: Expected elapsed time to be less than 180` |
| `js/web/url/url.test.ts` | `SyntaxError: Could not find export 'resolveObjectURL' in module 'node:buffer'` |
| `js/web/urlpattern/urlpattern.test.ts` | `ReferenceError: URLPattern is not defined` |
| `js/web/web-globals.test.js` | `ReferenceError: PerformanceMark is not defined` |
| `js/web/websocket/autobahn.test.ts` | `error: A functional 'docker' is required in CI for some tests.` |
| `js/web/websocket/websocket-client-short-read.test.ts` | `Error: ` |
| `js/web/websocket/websocket-handshake-event.test.ts` | `error: 'handshake' never fired` |
| `js/web/workers/message-channel.test.ts` | `error: expect(received).toHaveLength(expected)` |
| `js/web/workers/message-event.test.ts` | `TypeError: cannot read property 'bubbles' of null` |
| `js/web/workers/message-port-closed-leak.test.ts` | `bun-wasm: bun.wasm trapped: error while executing at wasm backtrace:` |
| `js/web/workers/message-port-pipe.test.ts` | `TypeError: cannot set property 'onmessage' of undefined` |
| `packages/registry/test/auth.test.ts` | `SuppressedError: ` |
| `regression/brotli-reset-leak.test.ts` | `error: test expects a function as the second argument` |
| `regression/issue/015201.test.ts` | `TypeError: The "callback" argument must be of type function. Received type number (1)` |
| `regression/issue/02499/02499.test.ts` | `error: write after end` |
| `regression/issue/03830.test.ts` | `error: expect(received).toMatchSnapshot(expected)` |
| `regression/issue/07500/07500.test.ts` | `Error: ` |
| `regression/issue/08095.test.ts` | `error: expect(received).toBeInstanceOf(expected)` |
| `regression/issue/08757.test.ts` | `error: Expected process to exit with code 0 but got 1` |
| `regression/issue/08964/08964.test.ts` | `error: expect(received).toBeUndefined()` |
| `regression/issue/09469.test.ts` | `error: expect(received).toHaveLength(expected)` |
| `regression/issue/09563/09563.test.ts` | `error: Cannot find module './empty.ts?i0' from '/bun/test/regression/issue/09563/09563.test.ts'` |
| `regression/issue/10139.test.ts` | `bun-wasm: bun.wasm trapped: error while executing at wasm backtrace:` |
| `regression/issue/11029-crypto-verify-null-algorithm.test.ts` | `NotSupportedError: Crypto generate failed` |
| `regression/issue/14799.test.ts` | `error: expect(received).toBeGreaterThan(expected)` |
| `regression/issue/1632.test.ts` | `error: expect(received).not.toBe(expected)` |
| `regression/issue/16476/16476.test.ts` | `error: Cannot find module './a.txt?1' from '/bun/test/regression/issue/16476/16476.test.ts'` |
| `regression/issue/17327.test.ts` | `error: expect(received).not.toMatch(expected)` |
| `regression/issue/18159/18159.test.ts` | `  ^ this test timed out after 2000ms, before its done callback was called. If a done callback was not intended, remove the last parameter from the test callback function` |
| `regression/issue/18242.test.ts` | `SyntaxError: Unexpected end of JSON input` |
| `regression/issue/19111.test.ts` | `TypeError: cannot read property 'method' of undefined` |
| `regression/issue/19661.test.ts` | `error: expect(received).toThrowError(expected)` |
| `regression/issue/23022-stack-trace-iterator.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/25231.test.ts` | `TypeError: Cannot convert undefined or null to object` |
| `regression/issue/25628.test.ts` | `error: test expects a function as the second argument` |
| `regression/issue/25862.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/26851.test.ts` | `<no error>` |
| `regression/issue/27478.test.ts` | `TypeError: formData() is not supported in bun-wasm` |
| `regression/issue/27890.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/28014.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/28017.test.ts` | `error: expect(received).toBeCloseTo(expected, precision)` |
| `regression/issue/28024.test.ts` | `TypeError: cannot read property 'update' of undefined` |
| `regression/issue/28431.test.ts` | `TypeError: The "chunk" argument must be of type string or an instance of Buffer or Uint8Array. Received an instance of Object` |
| `regression/issue/29072.test.ts` | `<no error>` |
| `regression/issue/29264.test.ts` | `error: test expects a function as the second argument` |
| `regression/issue/29283.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/29298.test.ts` | `<no error>` |
| `regression/issue/29787.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/31503.test.ts` | `error: expect(received).toMatchObject(expected)` |
| `regression/issue/32734.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/33227.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/39846.test.ts` | `  ^ this test timed out after 2000ms.` |
| `regression/issue/8254.test.ts` | `InternalError: out of memory` |
| `regression/issue/issue-1825-jest-mock-functions.test.ts` | `error: expect(received).not.toThrow()` |
| `regression/issue/malformed-integrity-base64.test.ts` | `error: Initial install failed` |

</details>

App matrix causes are separate because they unblock app stages rather than suite files.

- **Next first blockers**. QuickJS and JSC dev reject WebAssembly export tables; browser build rejects child IPC. Other failing Next commands have no diagnostic. All three production starts are blocked by build failures. Reproduce with `scripts/app-matrix.sh --apps=next --engines=quickjs,jsc,browser --hosts=native --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/next-rerun`. Suspected location `crates/bunwasm-runtime/src/js/webassembly.js:139`.
- **Prisma install memory ceiling**. Unblocks 9 blocked Prisma stages. Reproduce with `scripts/app-matrix.sh --apps=prisma --engines=quickjs,jsc,browser --hosts=native --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/prisma-rerun`. Suspected location `crates/bunwasm-runtime/src/engine.rs:1`.
- **Vite, Astro, SvelteKit and Vitest runtime failures after mirror repair**. The corrected replay has no mirror misses; 39 of the original 51 blocked stages were mirror misses. Reproduce each app with `scripts/app-matrix.sh --apps=<app> --engines=quickjs,jsc,browser --hosts=native,playground --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/<app>-rerun`. Suspected locations are the first blocker listed in the app table in `docs/app-matrix/README.md`.
