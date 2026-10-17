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

QuickJS is the sole comparable baseline by matched file selection; JSC and browser remain non-comparable. Changed runner, suite, and supplemental-dependency hashes prevent an isolated runtime-gain claim. See [README.md](README.md#historical-and-current-observations) and `summary.json` for selections and provenance.

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

App matrix causes are separate because they unblock app stages rather than suite files.

- **Next first blockers**. QuickJS and JSC dev reject WebAssembly export tables; browser build rejects child IPC. Other failing Next commands have no diagnostic. All three production starts are blocked by build failures. Reproduce with `scripts/app-matrix.sh --apps=next --engines=quickjs,jsc,browser --hosts=native --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/next-rerun`. Suspected location `crates/bunwasm-runtime/src/js/webassembly.js:139`.
- **Prisma install memory ceiling**. Unblocks 9 blocked Prisma stages. Reproduce with `scripts/app-matrix.sh --apps=prisma --engines=quickjs,jsc,browser --hosts=native --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/prisma-rerun`. Suspected location `crates/bunwasm-runtime/src/engine.rs:1`.
- **Vite, Astro, SvelteKit and Vitest runtime failures after mirror repair**. The corrected replay has no mirror misses; 39 of the original 51 blocked stages were mirror misses. Reproduce each app with `scripts/app-matrix.sh --apps=<app> --engines=quickjs,jsc,browser --hosts=native,playground --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/<app>-rerun`. Suspected locations are the first blocker listed in the app table in `docs/app-matrix/README.md`.
