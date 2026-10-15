# Failure groups

Each row describes the first observed blocker. Subsystem assignments marked 'needs reproduction' are provisional; they do not establish that every test needs the same fix. Full assignments and confidence are in [failures.tsv](failures.tsv).

| Category | First blocker / topic | Files | Example file | Test | Error |
|---|---|---|---|---|---|
| a | native addons or FFI | 61 | js/bun/ffi/cc.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'JSCallback' in module 'bun:ffi' |
| a | native addons, threads, watching or OS-only facilities | 13 | cli/bun.test.ts | bun > per-stream color detection > piped stdout stays plain when stderr is a tty | error: bun:ffi.dlopen is not supported in bun-wasm: no native libraries in wasm |
| a | network operations beyond the current host ABI | 13 | js/bun/dns/resolve-dns.test.ts | dns > lookup() [backend: system] > localhost > {"options":{"backend":"system"}} | error: Bun.dns.lookup is not supported in bun-wasm: WASI has no network access |
| b | CLI options, environment, cwd and script launching | 6 | cli/lint/bunfig.test.ts | [lint] in bunfig.toml > config = "other.config.js" | error: bun-wasm child concurrency limit reached (4 active children) |
| b | bundling, compiling, generated program output | 4 | bundler/compile-sourcemap-internal.test.ts | compile --sourcemap remaps stack frames to original line:col | error: Executable not found in bun-wasm: ./ismapp.js |
| b | external echo executable in normal-array control | 1 | js/bun/spawn/spawn-large-array-length.test.ts | spawn with spoofed array length > Bun.spawnSync still works with normal arrays | error: expect(received).toBe(expected) |
| b | network server/client behavior in a child program | 4 | js/bun/http/bun-serve-html.test.ts | serve html | error: Child process IPC is not supported in bun-wasm |
| b | package manager commands and lifecycle scripts | 5 | cli/install/bun-install-git-deps.test.ts | (unnamed) | error: Executable not found in bun-wasm: git |
| b | process lifecycle, exit and signal handling | 19 | js/bun/http/fetch-abort-ssl-context-eviction.test.ts | aborting fetches whose custom SSL context was evicted does not crash | error: bun-wasm child concurrency limit reached (4 active children) |
| b | runtime behavior or regression fixture in a child program | 22 | js/bun/glob/path-length.test.ts | Glob path length > deep directory tree does not overflow path buffer | error: Executable not found in bun-wasm: bash |
| b | test runner output, hooks, assertions and exit status | 6 | cli/test/test-changed.test.ts | bun test --changed > no changes -> runs nothing and exits 0 | error: git init -q failed in /tmp/test-changed-none_QRSt5n: |
| c | Bun.semver public API | 3 | js/bun/test/ci-restrictions.test.ts | <collection/hook/exit; no named failure> | TypeError: cannot read property 'satisfies' of undefined |
| c | boxed String paths from harness.tempDir | 1 | js/bun/resolve/png/test-png-import.test.js | png import | TypeError: The "paths[0]" property must be of type string, got object |
| c | test runner boolean or snapshot matchers | 74 | bake/app-options.test.ts | Bun.serve({ app }) rejects wrong-typed framework options | TypeError: not a function |
| c | test runner helpers or matcher methods | 3 | js/bun/module-graph/module-graph-isolation.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'setSystemTime' in module 'bun:test' |
| c | uninstalled suite dependency, setup work before API triage | 66 | bundler/transpiler/jsx-tsconfig-react-jsx.test.ts | tsconfig compilerOptions.jsx > "react-jsx" selects the matching automatic runtime | error: Cannot find package 'react' from '/tmp/jsx-tsconfig_tPYx4l/m.jsx' |
| d | Bun Cookie APIs | 8 | js/bun/cookie/cookie-exotic-inputs.test.ts | Bun.Cookie.parse with exotic inputs > handles cookies with various special characters in name | TypeError: cannot read property 'parse' of undefined |
| d | Bun TCP socket callbacks, current host ABI already supports TCP | 17 | cli/inspect/test-reporter.test.ts | TestReporter inspector protocol > retroactively reports tests when TestReporter.enable is called aft | error: Bun.listen is not supported in bun-wasm: WASI has no network access |
| d | Bun shell parser and execution | 57 | bake/dev/response-to-bake-response.test.ts | Response -> import { Response } from 'bun:app' transform in server components | error: Bun.$ is not supported in bun-wasm: WASI has no processes |
| d | Bun.ArrayBufferSink implementation | 3 | js/bun/spawn/spawn.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'ArrayBufferSink' in module 'bun' |
| d | CLI option or command implementation | 57 | bundler/cli.test.ts | bun build > generating a standalone binary with --outfile | error: unknown flag --compile |
| d | ES module mocking and loader invalidation | 7 | js/bun/test/mock/6874/A.test.ts | <collection/hook/exit; no named failure> | error: mock.module() is not supported in bun-wasm yet |
| d | HTTP/server/fetch/WebSocket semantics | 178 | bake/hmr-socket-protocol.test.ts | a duplicate testing-batch frame (H) during an in-flight bundle closes the socket instead of aborting | ReferenceError: WebSocket is not defined |
| d | Node's test API adapter | 31 | internal/runner-junit.test.ts | parseJunitFileSuites reads the report bun test --parallel --reporter=junit writes | error: expect(received).toContain(expected) |
| d | Node/Web stream semantics | 36 | cli/install/symlink-path-traversal.test.ts | symlink path traversal protection > rejects symlink targets that climb above the package root before | error: expect(received).toContain(expected) |
| d | SQLite API compatibility | 4 | js/bun/sqlite/column-types.test.js | SQLite Statement column types > reports correct column types for a variety of data types | TypeError: cannot read property 'columns' of undefined |
| d | TLS or HTTP/2 | 62 | cli/install/npmrc.test.ts | <collection/hook/exit; no named failure> | TypeError: Cannot convert undefined or null to object |
| d | bundler options, plugins or compiler output | 30 | bake/serve-plugins-dev-server.test.ts | DevServer is notified when [serve.static] plugin setup rejects | error: expect(received).toContain(expected) |
| d | crypto algorithms and WebCrypto | 30 | js/bun/crypto/cipheriv-decipheriv.test.ts | should encrypt & decrypt using update & final interface | error: crypto.createCipheriv is not supported in bun-wasm: only hashes, HMAC and random numbers are implemented |
| d | data parser/serializer semantics | 14 | cli/format/toml-layout.test.ts | TOML layout > formats every case without errors, and --check passes afterwards | error: expect(received).toEqual(expected) |
| d | database, Redis or S3 clients | 127 | js/bun/image/image.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'S3Client' in module 'bun' |
| d | filesystem API semantics | 2 | js/bun/util/filesystem_router.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'FileSystemRouter' in module 'bun' |
| d | portable caller source tracking used by the bundler test helper | 83 | bake/dev-and-prod.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'callerSourceOrigin' in module 'bun:jsc' |
| d | test runner/assertion or runtime semantics | 681 | bundler/standalone.test.ts | compile --target=browser > inlines JS and CSS into HTML | error: expect(received).toBe(expected) |
| d | timeout, first unblock and rerun without reducing it to an API verdict | 9 | internal/source-lints/byte-search.test.ts | <collection/hook/exit; no named failure> | <see JSON excerpt; no error line> |
| d | unresolved runtime/module semantics, inspect the recorded failure first | 69 | bundler/bun-build-compile-wasm.test.ts | Bun.build compile with wasm > compile with wasm module imports | <see JSON excerpt; no error line> |
| e | private native-engine/compiler instrumentation has no portable equivalent | 92 | bake/deinitialization.test.ts | dev server deinitializes itself | SyntaxError: Could not find export 'getDevServerDeinitCount' in module 'bun:internal-for-testing' |
| f | passes on browser | 13 | js/bun/glob/leak.test.ts | <collection/hook/exit; no named failure> | <see JSON excerpt; no error line> |
| f | passes on browser, jsc | 5 | js/bun/jsc/webkit-upgrade-ccdcb8a026.test.ts | WebKit ccdcb8a026 upgrade > Atomics.isLockFree uses ToIntegerOrInfinity instead of wrapping to int32 | ReferenceError: Atomics is not defined |

## Regressions from the previous baseline

- `js/bun/io/fetch/fetch-abort-slow-connect.test.ts`
- `js/node/promise/reject-tostring.test.ts`
- `regression/issue/01466.test.ts`
- `regression/issue/015201.test.ts`

## Timeout index

Every row has a 15-second wall deadline. A completed report can also come from a child test command; it does not prove that the parent completed. Reproduce with the README command and the exact file path below. See [investigations.md](investigations.md) for longer reruns and diagnoses.

| File | Change | Report observed | Passes | Last failure observed | First error |
|---|---|---|---|---|---|
| cli/check/check.test.ts | new | False | 6 | bun check > cases not covered by TypeScript's test suite > a comment before the constraint of a type parameter | error: expect(received).toContain(expected) |
| cli/hot/hot.test.ts | new | False | 0 | should not remap against a stale sourcemap after a partial-file reload | error: expect(received).toContain(expected) |
| cli/lint/config-files.test.ts | new | False | 11 | the configuration files of ESLint 8 > what ESLint 8.57.1 does: packages: the nearest node_modules wins .. | error: expect(received).toContain(expected) |
| cli/lint/oxc-names.test.ts | new | False | 0 | beside an .oxlintrc.json, like oxc's parser > what oxc looks for at the end of a file comes in its order | error: expect(received).toBe(expected) |
| cli/test/isolation.test.ts | new | False | 7 | --isolate: a finished file's late completions do not run in the next file > --parallel | error: expect(received).toContain(expected) |
| cli/test/parallel.test.ts | new | False | 0 | --parallel --bail stops dispatching new files after threshold | error: expect(received).not.toContain(expected) |
| internal/source-lints/byte-search.test.ts | new | False | 0 | no named failure | no error captured |
| internal/source-lints/dead-code-escapes.test.ts | new | False | 0 | no named failure | no error captured |
| internal/source-lints/empty-jsvalue-laundering.test.ts | new | False | 0 | no named failure | no error captured |
| internal/source-lints/fn-long-mut-reborrow.test.ts | new | False | 0 | no named failure | no error captured |
| internal/source-lints/frozen-nonnull-reborrow.test.ts | new | False | 0 | no named failure | no error captured |
| js/bun/bun-object/deep-equals-temporal.test.ts | new | False | 16 | Bun.deepEquals on Temporal values (strict: false) > different values of the same class are not equal (case 21) | RangeError: Offset +02:00 is invalid for 2024-06-15T12:34:56 in Europe/Berlin |
| js/bun/gc/gc-controller-cadence.test.ts | new | False | 3 | idle release > an idle collection finishes while the program is parked | error: expect(received).toContain(expected) |
| js/bun/glob/leak.test.ts | new | False | 1 | no named failure | no error captured |
| js/bun/http/async-iterator-stream.test.ts | existing | False | 1 | Bun.serve: an iterator with next(), return() and throw() is closed with return() > behind tee(), the other branch cancelled > when the client hangs up | error: expect(received).toBe(expected) |
| js/bun/http/bun-serve-file.test.ts | new | False | 0 | file routes frame a slice that reaches or starts past EOF by the bytes they serve | error: expect(received).toBe(expected) |
| js/bun/http/bun-serve-html-build-holds-server.test.ts | new | False | 0 | no named failure | no error captured |
| js/bun/http/bun-server.test.ts | existing | False | 10 | server.stop() drain promise counts open connections > in-flight request completes across stop(), then its connection is closed | error: expect(received).toBe(expected) |
| js/bun/http/hspec.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/http/node-http-halfclose-midupload.test.ts | existing | False | 0 | write after res.socket.end() mid-upload completes every teardown stage (IPv4 loopback) | TypeError: not a function |
| js/bun/http/proxy-stress-concurrent.test.ts | existing | False | 1 | idle pooled tunnel receiving data is evicted | error: expect(received).toBeGreaterThanOrEqual(expected) |
| js/bun/http/request-smuggling.test.ts | existing | False | 7 | SPILL.TERM - invalid chunk terminators > rejects zero-chunk terminator with CR but wrong second byte | error: expect(received).toContain(expected) |
| js/bun/http/serve-async-stream-client-abort.test.ts | new | False | 0 | no named failure | no error captured |
| js/bun/http/serve-direct-readable-stream.test.ts | existing | False | 0 | HTTPResponseSink displays correct message | TypeError: not a function |
| js/bun/http/serve-http2-lifecycle.test.ts | new | False | 0 | no named failure | no error captured |
| js/bun/http/serve-pending-promise-abort-leak.test.ts | existing | False | 1 | resolve() inside abort handler is handled safely | error: expect(received).toBe(expected) |
| js/bun/http/serve-response-stream-sink-leak.test.ts | new | False | 0 | no named failure | no error captured |
| js/bun/http/serve.test.ts | existing | False | 112 | idle timeout closes a tls connection whose client stopped reading the response | error: expect(received).toContain(expected) |
| js/bun/http/tls-keepalive.test.ts | existing | False | 0 | no named failure | no error captured |
| js/bun/jsonl/jsonl-parse.test.ts | new | False | 192 | Bun.JSONL > unexpected content after a value > nesting deeper than the native stack | RangeError: invalid array buffer length |
| js/bun/module-graph/module-graph-workers.test.ts | new | False | 0 | ModuleGraph and workers, C: a worker hosts a graph whose code starts a worker > the graph's node Worker is drain, in a node Worker: the main thread terminates the worker | error: expect(received).toEqual(expected) |
| js/bun/spawn/spawn-signal.test.ts | new | False | 2 | spawnSync AbortSignal throws if already aborted | error: expect(received).toEqual(expected) |
| js/bun/terminal/terminal-platform-gaps.test.ts | new | False | 0 | Bun.Terminal platform behaviour > SAME: child stdout reaches data callback | TypeError: not a function |
| js/node/buffer-indexof-worstcase.test.ts | existing | False | 0 | no named failure | no error captured |
| js/node/fs/abort-signal-leak-read-write-file.test.ts | new | False | 0 | no named failure | no error captured |
| js/node/http/node-http-connect.test.ts | new | True | 0 | CONNECT: process exits after the tunnel socket is re-emitted as a connection and the server closes | TypeError: value is not disposable |
| js/node/http/node-http-req-socket-pause.test.ts | existing | False | 0 | request that its handler pause()d, with a body below the highWaterMark > is aborted when the client half-closes before the response, like a request that is not paused |   ^ this test timed out after 2000ms. |
| js/node/http/node-http-server-close-drain.test.ts | existing | False | 3 | server.close() does not reap a connection that still receives a Content-Length request body, called after the client has the early response | error: expect(received).toBe(expected) |
| js/node/http/node-http-server-timeouts.test.ts | existing | False | 2 | node:http server timeout enforcement > with pipelining, 'timeout' goes to the incoming request, the response that owns the socket, then the server |   ^ this test timed out after 2000ms. |
| js/node/http/node-http-uaf.test.ts | new | False | 0 | should not crash on abort (node-http-uaf-fixture.ts) | error: expect(received).toBe(expected) |
| js/node/module/node-module-module.test.js | existing | False | 3 | node-module-module > module.Module works | error: expect(received).toHaveLength(expected) |
| js/node/net/handle-leak.test.ts | existing | False | 0 | no named failure | no error captured |
| js/node/tls/fetch-tls-cert.test.ts | existing | False | 0 | Fail to complete server's chain |   ^ this test timed out after 2000ms. |
| js/node/url/pathToFileURL.test.ts | new | False | 0 | no named failure | no error captured |
| js/web/fetch/body-mixin-errors.test.ts | existing | False | 2 | body-mixin-errors > fetch: Response wrapping a stream that errored while idle rejects bytes() | error: expect(received).toBe(expected) |
| js/web/fetch/body-stream.test.ts | existing | False | 30 | body-stream over http/3 > Request.prototoype.arrayBuffer() fetch(url) (force fast ReadableStream conversion) (clone) > "Hello World 123" | TypeError: not a function |
| js/web/fetch/fetch-http3-adversarial.test.ts | existing | False | 0 | http3 adversarial body=524288 > POST /slow-echo (slow consumer) |   ^ this test timed out after 2000ms. |
| js/web/fetch/fetch-leak.test.ts | new | False | 13 | fetch() does not leak streaming decompressor state across fragmented compressed responses | error: Child process IPC is not supported in bun-wasm |
| js/web/fetch/fetch-proxy-connect-tunnel-split-envelope.test.ts | new | False | 0 | no named failure | no error captured |
| js/web/fetch/fetch-response-finalizer-sweep.test.ts | new | False | 0 | no named failure | no error captured |
| js/web/fetch/fetch.stream.test.ts | existing | False | 4 | fetch() with streaming > can handle fixture img x small text | error: expect(received).toBe(expected) |
| js/web/fetch/fetch.tls.test.ts | existing | False | 0 | fetch-tls > fetch with valid tls and non-native checkServerIdentity that throws should reject |   ^ this test timed out after 2000ms. |
| js/web/request/request-clone-leak.test.ts | existing | False | 0 | no named failure | no error captured |
| js/web/request/request-method-getter.test.ts | existing | False | 0 | new Request(http://localhost:3000/).clone().method doesnt create a new JSString every time | error: expect(received).toBeLessThan(expected) |
| js/web/timers/setImmediate2.test.ts | existing | False | 0 | no named failure | no error captured |
| js/web/websocket/websocket-server-send-from-drain.test.ts | existing | False | 0 | no named failure | no error captured |
| regression/issue/42989.test.ts | new | False | 0 | no named failure | no error captured |
