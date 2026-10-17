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

The before→current comparison is recorded in [README.md](README.md#before--current) and `summary.json`.

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

Rank is the number of suite files with the same first blocker. Each item has a bounded reproducer and the first suspected implementation location.

1. **test runner/assertion or runtime semantics**. Unblocks 720 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/bunfig-test-options.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_test.js:1`; example `cli/bunfig-test-options.test.ts`. First observed error: `error: expect(received).not.toEqual(expected)`.

2. **HTTP/server/fetch/WebSocket semantics**. Unblocks 180 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/dev/ecosystem.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/net.js:1`; example `bake/dev/ecosystem.test.ts`. First observed error: `<see JSON excerpt; no error line>`.

3. **database, Redis or S3 clients**. Unblocks 128 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/image/image.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/bun_sqlite.js:1`; example `js/bun/image/image.test.ts`. First observed error: `SyntaxError: Could not find export 'S3Client' in module 'bun'`.

4. **private native-engine/compiler instrumentation has no portable equivalent**. Unblocks 93 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/deinitialization.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`; example `bake/deinitialization.test.ts`. First observed error: `SyntaxError: Could not find export 'getDevServerDeinitCount' in module 'bun:internal-for-testing'`.

5. **TLS or HTTP/2**. Unblocks 84 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/bun-install-stalled-tls.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/net.js:598`; example `cli/install/bun-install-stalled-tls.test.ts`. First observed error: `error: expect(received).toEqual(expected)`.

6. **unresolved runtime/module semantics, inspect the recorded failure first**. Unblocks 72 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/hmr-socket-protocol.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/modules.rs:1`; example `bake/hmr-socket-protocol.test.ts`. First observed error: `  ^ this test timed out after 2000ms.`.

7. **bundler options, plugins or compiler output**. Unblocks 71 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/app-options.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`; example `bake/app-options.test.ts`. First observed error: `error: expect(received).toMatchInlineSnapshot(expected)`.

8. **Bun shell parser and execution**. Unblocks 63 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/dev/production.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/spawn.js:1`; example `bake/dev/production.test.ts`. First observed error: `error: Bun.$ is not supported in bun-wasm: WASI has no processes`.

9. **native addons or FFI**. Unblocks 62 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/ffi/cc.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`; example `js/bun/ffi/cc.test.ts`. First observed error: `SyntaxError: Could not find export 'JSCallback' in module 'bun:ffi'`.

10. **uninstalled suite dependency, setup work before API triage**. Unblocks 49 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bundler/bundler_edgecase.test.ts`.
   Suspected location `docs/bun-test-suite/dependencies/package.json:1`; example `bundler/bundler_edgecase.test.ts`. First observed error: `error: Cannot find package 'aws-cdk-lib' from '/bun/test/bundler/bundler_edgecase.test.ts'`.

11. **CLI option or command implementation**. Unblocks 46 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bundler/bundler_bun.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/builtins.js:1`; example `bundler/bundler_bun.test.ts`. First observed error: `error: Bundle Failed`.

12. **runtime behavior or regression fixture in a child program**. Unblocks 35 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" bake/dev-and-prod.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/spawn.js:57`; example `bake/dev-and-prod.test.ts`. First observed error: `error: Child process IPC is not supported in bun-wasm`.

13. **Node/Web stream semantics**. Unblocks 29 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" cli/install/symlink-path-traversal.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/streams_polyfill.js:1`; example `cli/install/symlink-path-traversal.test.ts`. First observed error: `error: expect(received).toContain(expected)`.

14. **crypto algorithms and WebCrypto**. Unblocks 23 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/crypto/cipheriv-decipheriv.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/crypto.js:1`; example `js/bun/crypto/cipheriv-decipheriv.test.ts`. First observed error: `error: crypto.createCipheriv is not supported in bun-wasm: this Node crypto operation is not implemented`.

15. **process lifecycle, exit and signal handling**. Unblocks 20 suite files.
   Reproduce with `scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" js/bun/http/fetch-abort-ssl-context-eviction.test.ts`.
   Suspected location `crates/bunwasm-runtime/src/js/spawn.js:370`; example `js/bun/http/fetch-abort-ssl-context-eviction.test.ts`. First observed error: `error: bun-wasm child concurrency limit reached (4 active children)`.

App matrix causes are separate because they unblock app stages rather than suite files.

- **Offline registry missing `esbuild-wasm`**. Unblocks 51 blocked stages across Vite, Astro, SvelteKit and Vitest. Reproduce with `scripts/app-matrix.sh --apps=vite-vanilla,vite-react,vite-vue,astro,sveltekit,vitest --engines=quickjs,jsc,browser --hosts=native,playground --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/app-matrix-rerun`. Suspected location `scripts/app-matrix/registry.mjs:1`.
- **WebAssembly export tables in Next**. Unblocks 6 native Next dev/build stages. Reproduce with `scripts/app-matrix.sh --apps=next --engines=quickjs,jsc,browser --hosts=native --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/next-rerun`. Suspected location `crates/bunwasm-runtime/src/js/webassembly.js:139`.
- **Prisma install memory ceiling**. Unblocks 12 Prisma stages. Reproduce with `scripts/app-matrix.sh --apps=prisma --engines=quickjs,jsc,browser --hosts=native --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/prisma-rerun`. Suspected location `crates/bunwasm-runtime/src/engine.rs:1`.
