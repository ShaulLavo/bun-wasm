# Category d runner and runtime failures

Status: Approved.

The 2026-10-17 scoreboard assigned 720 files to category d with topic
`test runner/assertion or runtime semantics`. Its first-error signatures are
not root causes. For example, `toBe` failures include formatter output,
Windows paths, missing module APIs, and process behavior.

[category-d-first-errors.tsv](category-d-first-errors.tsv) preserves this exact
720-file selection, including each recorded test, error, and cause assignment.
[category-d-causes.json](category-d-causes.json) names the assigned causes.
Assignments reuse the source-backed investigations in [triage.md](triage.md),
with Windows paths and options-before-callback registration separated here.
Unresolved entries remain explicit. They are not assigned a shared runtime bug
merely because they call the same assertion method.

Regenerate the tables with `node scripts/group-suite-category-d.ts`.
Use `node scripts/group-suite-category-d.ts --check` to check the committed tables.
The manifest remains a historical selection when the live scoreboard changes.

## First-error groups

<!-- first-errors:start -->
| Recorded first error | Files | Example |
| --- | --- | --- |
| `error: expect(received).toBe(expected)` | 150 | `cli/format/bunfig.test.ts` |
| `TypeError: not a function` | 80 | `cli/install/GHSA-pfwx-36v6-832x.test.ts` |
| `error: expect(received).toContain(expected)` | 66 | `cli/check/check.test.ts` |
| `error: expect(received).toEqual(expected)` | 65 | `cli/format/oxfmt-cli/oxfmt-cli.test.ts` |
| `error: expect(received).toMatchInlineSnapshot(expected)` | 37 | `cli/install/bun-install-patch.test.ts` |
| `error: expect(received).toThrow(expected)` | 26 | `js/bun/cron/in-process-cron.test.ts` |
| `error: expect(received).not.toContain(expected)` | 18 | `cli/install/bun-install-link-path.test.ts` |
| `AssertionError: Expected values to be strictly equal:` | 11 | `js/bun/perf_hooks/histogram.test.ts` |
| `SyntaxError: Unexpected end of JSON input` | 11 | `cli/lint/bun-rules.test.ts` |
| `<see JSON excerpt; no error line>` | 9 | `js/bun/glob/proto.test.ts` |
| `error: expect(received).toMatch(expected)` | 7 | `cli/install/public-hoist-pattern.test.ts` |
| `error: expect(received).toMatchObject(expected)` | 7 | `cli/inspect/inspect.test.ts` |
| `error: Expected process to exit with code 0 but got 1` | 7 | `js/bun/resolve/bun-lock.test.ts` |
| `error: Network is unreachable (os error 101)` | 7 | `integration/expo-app/expo.test.ts` |
| `error: expect(received).toMatchSnapshot(expected)` | 6 | `cli/install/migration/npm-arborist.test.ts` |
| `ReferenceError: HTMLRewriter is not defined` | 6 | `js/web/html/html-rewriter-doctype.test.ts` |
| `error: expect(received).toBeGreaterThan(expected)` | 5 | `cli/install/bun-install-env-file.test.ts` |
| `error: expect(received).toThrow()` | 5 | `js/bun/console/console-table.test.ts` |
| `ReferenceError: Worker is not defined` | 5 | `js/bun/util/bun-isMainThread.test.js` |
| `error: expect(received).toHaveLength(expected)` | 4 | `js/bun/spawn/spawn.test.ts` |
| `error: test expects a function as the second argument` | 4 | `cli/install/bun-install-tarball-integrity.test.ts` |
| `TypeError: cannot read property 'html' of undefined` | 4 | `js/bun/md/gfm-compat.test.ts` |
| `AssertionError: Expected values to be strictly deep-equal:` | 3 | `js/node/child_process/child_process-node.test.js` |
| `bun-wasm: bun.wasm trapped: error while executing at wasm backtrace:` | 3 | `js/bun/resolve/require-esm-evaluating-cycle.test.ts` |
| `error: expect(received).not.toBe(expected)` | 3 | `js/node/util/bun-inspect.test.ts` |
| `error: expect(received).toBeEmpty()` | 3 | `cli/run/empty-file.test.ts` |
| `error: expect(received).toBeNull()` | 3 | `js/node/assert/deep-equal.test.ts` |
| `error: expect(received).toBeUndefined()` | 3 | `cli/test/coverage.test.ts` |
| `error: expect(received).toThrowErrorMatchingInlineSnapshot()` | 3 | `js/bun/spawn/readablestream-helpers.test.ts` |
| `error: zlib.zstdCompressSync is not supported in bun-wasm: brotli is not compiled into bun.wasm` | 3 | `js/web/streams/compression.test.ts` |
| `TypeError: Cannot convert undefined or null to object` | 3 | `js/bun/ini/ini.test.ts` |
| `AssertionError: Missing expected exception (TypeError).` | 2 | `js/node/url/url-canParse-whatwg.test.js` |
| `BuildError: Unexpected <` | 2 | `js/bun/resolve/xml/xml.test.js` |
| `Error:` | 2 | `js/web/websocket/websocket-client-short-read.test.ts` |
| `error: A functional 'docker' is required in CI for some tests.` | 2 | `cli/install/bun-install-proxy.test.ts` |
| `error: Child process pipe is closed` | 2 | `cli/update_interactive_snapshots.test.ts` |
| `error: exit code 1` | 2 | `cli/lint/glob.test.ts` |
| `error: expect(received).not.toEqual(expected)` | 2 | `cli/bunfig-test-options.test.ts` |
| `error: expect(received).not.toThrow()` | 2 | `regression/issue/012039.test.ts` |
| `error: expect(received).toBeFalse()` | 2 | `js/bun/util/bun-file-exists.test.js` |
| `error: expect(received).toBeFunction()` | 2 | `internal/sigaction-layout.test.ts` |
| `error: expect(received).toBeInstanceOf(expected)` | 2 | `js/node/assert/assert-typedarray-deepequal.test.ts` |
| `error: expect(received).toStartWith(expected)` | 2 | `cli/lint/messages.test.ts` |
| `error: expected 200 "OK", got 400 "Bad Request"` | 2 | `js/third_party/express/express.json.test.ts` |
| `error: secretOrPrivateKey must be an asymmetric key when using ES256` | 2 | `js/third_party/jsonwebtoken/jwt.asymmetric_signing.test.js` |
| `error: zlib.zstdCompress is not supported in bun-wasm: brotli is not compiled into bun.wasm` | 2 | `regression/issue/23314/zstd-large-decompression.test.ts` |
| `SyntaxError: Could not find export 'expectTypeOf' in module 'bun:test'` | 2 | `js/bun/test/expect-type-doctest.test.ts` |
| `TypeError: cannot read property 'name' of undefined` | 2 | `js/bun/util/bun-cryptohasher.test.ts` |
| `TypeError: object is not extensible` | 2 | `js/bun/namespace-prototype-pollution.test.ts` |
| `TypeError: The "callback" argument must be of type function. Received type number (1)` | 2 | `js/node/timers/node-timers.test.ts` |
| `AssertionError: Expected "Error: foo` | 1 | `js/node/util/node-inspect-tests/parallel/util-format.test.js` |
| `AssertionError: Missing expected exception (RangeError).` | 1 | `js/node/fs/fs-write-offset-bound.test.ts` |
| `AssertionError: wonky format(http://google.com" onload="alert(42)/) == http://google.com/%22%20onload=%22alert(42)/` | 1 | `js/node/url/url-format.test.js` |
| `ERR: error: bun audit is not supported in bun-wasm` | 1 | `cli/install/bun-audit.test.ts` |
| `error: 'handshake' never fired` | 1 | `js/web/websocket/websocket-handshake-event.test.ts` |
| `error: "generate-string" fixture exited with code 1` | 1 | `js/bun/util/v8-heap-snapshot.test.ts` |
| `error: [/usr/local/bin/bun] Not all stdin was sent. Unsent: ["abc\n","pause\n","def\n"]` | 1 | `js/node/process/stdin/stdin-fixtures.test.ts` |
| `error: 4` | 1 | `cli/run/esm-defineProperty.test.ts` |
| `error: bun create is not supported in bun-wasm` | 1 | `cli/install/bun-create.test.ts` |
| `error: bun init is not supported in bun-wasm` | 1 | `cli/init/init.test.ts` |
| `error: bun install failed (exit 1)` | 1 | `integration/datadog-pprof/datadog-pprof.test.ts` |
| `error: bun lint is not supported in bun-wasm` | 1 | `cli/lint/import-attributes.test.ts` |
| `error: bun x is not supported in bun-wasm` | 1 | `js/third_party/pnpm/pnpm.test.ts` |
| `error: Bun.unsafe.arrayBufferToString is not supported in bun-wasm: zero-copy strings are not exposed` | 1 | `js/bun/util/unsafe.test.js` |
| `error: Cannot find module '../../../' from '/bun/test/integration/bun-types/bun-types.test.ts'` | 1 | `integration/bun-types/bun-types.test.ts` |
| `error: Cannot find module './a.txt?1' from '/bun/test/regression/issue/16476/16476.test.ts'` | 1 | `regression/issue/16476/16476.test.ts` |
| `error: Cannot find module './empty.ts?i0' from '/bun/test/regression/issue/09563/09563.test.ts'` | 1 | `regression/issue/09563/09563.test.ts` |
| `error: Cannot find module './haha.mjs' from '/bun/test/js/bun/resolve/import-meta-resolve.test.mjs'` | 1 | `js/bun/resolve/import-meta-resolve.test.mjs` |
| `error: Cannot find module './import-query-fixture.ts?query' from '/bun/test/js/bun/resolve/import-query.test.ts'` | 1 | `js/bun/resolve/import-query.test.ts` |
| `error: Cannot find module './text-loader-fixture-text-file.txt?0' from '/bun/test/js/bun/util/text-loader-fixture-dynamic-import-stress.ts'` | 1 | `js/bun/util/text-loader.test.ts` |
| `error: Cannot find module '#foo/wildcard.js' from '/bun/test/js/bun/resolve/resolve-test.js'` | 1 | `js/bun/resolve/resolve.test.ts` |
| `error: cannot GET /?q=https%3A%2F%2Fgoogle.com'.bb.com%2F1.html (400)` | 1 | `js/third_party/express/res.location.test.ts` |
| `error: Error message` | 1 | `js/node/util/node-inspect-tests/internal-inspect.test.js` |
| `error: error: Module not found "node"` | 1 | `cli/run/as-node.test.ts` |
| `error: error: Module not found "start:dev"` | 1 | `cli/run/run-process-env.test.ts` |
| `error: error: Module not found "test"` | 1 | `cli/run/run-quote.test.ts` |
| `error: expect(received).not.toBeNull()` | 1 | `cli/run/crash-report-command-char.test.ts` |
| `error: expect(received).not.toMatch(expected)` | 1 | `regression/issue/17327.test.ts` |
| `error: expect(received).rejects.toThrow(expected)` | 1 | `js/node/timers.promises/timers.promises.test.ts` |
| `error: expect(received).toBeCloseTo(expected, precision)` | 1 | `regression/issue/28017.test.ts` |
| `error: expect(received).toBeDefined()` | 1 | `js/bun/jsc/heapStats-mimalloc.test.ts` |
| `error: expect(received).toBeFinite()` | 1 | `cli/test/test-randomize.test.ts` |
| `error: expect(received).toBeLessThan(expected)` | 1 | `js/web/request/request-method-getter.test.ts` |
| `error: expect(received).toBeTrue()` | 1 | `cli/run/transpiler-cache.test.ts` |
| `error: expect(received).toBeTruthy()` | 1 | `js/deno/event/event.test.ts` |
| `error: expect(received).toBeTypeOf()` | 1 | `js/bun/test/jest-extended.test.js` |
| `error: expect(received).toEndWith(expected)` | 1 | `js/bun/webview/webview-chrome-disconnect.test.ts` |
| `error: expect(received).toStrictEqual(expected)` | 1 | `cli/install/bun-dedupe.test.ts` |
| `error: expect(received).toThrowError(expected)` | 1 | `js/node/url/url-parse-ipv6.test.ts` |
| `error: Expected ";" but found ":"` | 1 | `cli/run/run-extensionless.test.ts` |
| `error: Expected ";" but found "wah"` | 1 | `cli/run/run-shell.test.ts` |
| `error: expected body '<!DOCTYPE html>\n' +` | 1 | `js/third_party/express/res.sendFile.test.ts` |
| `error: Expected BuildMessage, got BuildError` | 1 | `js/bun/resolve/build-error.test.ts` |
| `error: Expected closing JSX tag to match opening tag "<div>"` | 1 | `regression/issue/14477/14477.test.ts` |
| `error: Expected elapsed time to be less than 180` | 1 | `js/web/timers/setInterval.test.js` |
| `error: Expected stdout to be "{\n  \"line\": 3,\n  \"column\": 17,\n  \"originalLine\": 1,\n  \"originalColumn\": 18\n}" but got "{}"` | 1 | `js/bun/test/stack.test.ts` |
| `error: Expected success but got code 1. stderr: error: Only bun pm ls is supported in bun-wasm` | 1 | `cli/install/bun-pm-pkg.test.ts` |
| `error: expected undefined to have npm string width 0 but got 9` | 1 | `js/bun/util/stringWidth.test.ts` |
| `error: Failed to create user config-precedence: 500 {"error":"Internal Server Error"}` | 1 | `cli/install/config-precedence.test.ts` |
| `error: Failed to create user publish-tests: 500 {"error":"Internal Server Error"}` | 1 | `cli/install/bun-publish.test.ts` |
| `error: Failed to read asymmetric key` | 1 | `js/third_party/jsonwebtoken/validateAsymmetricKey.test.js` |
| `error: get: Symbol(nodejs.util.inspect.custom)` | 1 | `js/node/util/node-inspect-tests/parallel/util-inspect-proxy.test.js` |
| `error: Initial install failed` | 1 | `regression/issue/malformed-integrity-base64.test.ts` |
| `error: inspector.url is not supported in bun-wasm: no debugger` | 1 | `js/node/inspector/inspector.test.ts` |
| `error: Module not found "--bun"` | 1 | `cli/run/commonjs-no-export.test.ts` |
| `error: No such module: constants` | 1 | `js/node/process-binding.test.ts` |
| `error: No such module: tty_wrap` | 1 | `js/node/nodettywrap.test.ts` |
| `error: objdump executable not found. Please install it.` | 1 | `js/bun/symbols.test.ts` |
| `error: pack failed: error: Unknown install option: --quiet` | 1 | `cli/install/bun-pm-diff.test.ts` |
| `error: process.env is not an object` | 1 | `js/node/process/process.test.js` |
| `error: Secret not found: S3_R2_ACCESS_KEY` | 1 | `js/bun/s3/s3.leak.test.ts` |
| `error: Secret not found: SMTP_MAILGUN_PASS` | 1 | `js/third_party/nodemailer/nodemailer.test.ts` |
| `error: setup install exited with 1:` | 1 | `cli/install/bun-security-scanner-matrix-with-node-modules.test.ts` |
| `error: test` | 1 | `js/bun/spawn/spawn-stdin-destroy.test.ts` |
| `error: test/node_modules has vitest <missing> but test/package.json requires 4.1.9. Run 'bun install' in test/ before running this test.` | 1 | `js/third_party/vitest/vitest.test.ts` |
| `error: Unexpected return from matcher function 'toThrowWithCodeAsync'.` | 1 | `js/bun/bun-object/write.spec.ts` |
| `error: Unexpected value` | 1 | `js/bun/resolve/resolve-ts.test.ts` |
| `error: Unix sockets and TLS sockets are not supported in bun-wasm` | 1 | `cli/inspect/test-reporter.test.ts` |
| `error: Unsupported platform: linux wasm32 LE` | 1 | `js/third_party/esbuild/esbuild-child_process.test.ts` |
| `error: write after end` | 1 | `regression/issue/02499/02499.test.ts` |
| `error: zlib.brotliCompressSync is not supported in bun-wasm: brotli is not compiled into bun.wasm` | 1 | `js/node/zlib/zlib.test.js` |
| `Install STDERR: error: Network is unreachable (os error 101)` | 1 | `regression/issue/26657.test.ts` |
| `InternalError: out of memory` | 1 | `regression/issue/8254.test.ts` |
| `NotSupportedError: Crypto generate failed` | 1 | `regression/issue/11029-crypto-verify-null-algorithm.test.ts` |
| `RangeError: Offset +02:00 is invalid for 2024-06-15T12:34:56 in Europe/Berlin` | 1 | `js/bun/bun-object/deep-equals-temporal.test.ts` |
| `RangeError: Unsupported encoding label "ibm866"` | 1 | `js/web/encoding/text-decoder-single-byte.test.ts` |
| `RangeError: Unsupported encoding label "IBM866"` | 1 | `js/web/encoding/text-decoder-wpt.test.ts` |
| `RangeError: Unsupported encoding label "shift_jis"` | 1 | `js/web/encoding/text-decoder-cjk.test.ts` |
| `ReferenceError: Atomics is not defined` | 1 | `js/web/atomics.test.ts` |
| `ReferenceError: expectTypeOf is not defined` | 1 | `js/bun/test/expect-type-global.test.ts` |
| `ReferenceError: PerformanceMark is not defined` | 1 | `js/web/web-globals.test.js` |
| `ReferenceError: require is not defined` | 1 | `cli/run/require-cache.test.ts` |
| `ReferenceError: ShadowRealm is not defined` | 1 | `js/bun/jsc/shadow.test.js` |
| `SuppressedError:` | 1 | `packages/registry/test/auth.test.ts` |
| `SyntaxError: Could not find export 'onTestFinished' in module 'bun:test'` | 1 | `js/bun/test/test-on-test-finished.test.ts` |
| `SyntaxError: Expected property name or '}' in JSON at position 13 (line 3 column 7)` | 1 | `cli/run/require-and-import-trailing.test.ts` |
| `SyntaxError: import.meta only valid in module code` | 1 | `js/third_party/es-module-lexer/es-module-lexer.test.ts` |
| `Total data received: 524288 bytes` | 1 | `js/node/zlib/deflate-streaming.test.ts` |
| `TypeError: cannot convert BigInt to number` | 1 | `cli/install/bun-pm-cache-pack.test.ts` |
| `TypeError: cannot read property 'backend' of undefined` | 1 | `js/bun/image/image-adversarial.test.ts` |
| `TypeError: cannot read property 'bubbles' of null` | 1 | `js/web/workers/message-event.test.ts` |
| `TypeError: cannot read property 'connectivityState' of undefined` | 1 | `js/third_party/grpc-js/test-pick-first.test.ts` |
| `TypeError: cannot read property 'cpuTime' of undefined` | 1 | `js/bun/spawn/spawn_waiter_thread.test.ts` |
| `TypeError: cannot read property 'credentials' of undefined` | 1 | `js/third_party/grpc-js/test-client.test.ts` |
| `TypeError: cannot read property 'internal/dgram' of undefined` | 1 | `js/bun/udp/dgram.test.ts` |
| `TypeError: cannot read property 'isUTF16String' of undefined` | 1 | `js/web/encoding/text-decoder.test.js` |
| `TypeError: cannot read property 'loadPackageDefinition' of undefined` | 1 | `js/third_party/grpc-js/test-channelz.test.ts` |
| `TypeError: cannot read property 'maxRSS' of undefined` | 1 | `cli/lint/react-compiler.test.ts` |
| `TypeError: cannot read property 'method' of undefined` | 1 | `regression/issue/19111.test.ts` |
| `TypeError: cannot read property 'presign' of undefined` | 1 | `js/bun/s3/s3-numeric-options-coerce.test.ts` |
| `TypeError: cannot read property 'react' of undefined` | 1 | `js/bun/md/md-react.test.ts` |
| `TypeError: cannot read property 'render' of undefined` | 1 | `js/bun/md/md-render-callback.test.ts` |
| `TypeError: cannot read property 'Server' of undefined` | 1 | `js/third_party/grpc-js/test-outlier-detection.test.ts` |
| `TypeError: cannot read property 'setLogger' of undefined` | 1 | `js/third_party/grpc-js/test-logging.test.ts` |
| `TypeError: cannot read property 'startsWith' of null` | 1 | `js/bun/util/bun-file-fd-read.test.ts` |
| `TypeError: cannot read property 'supportedLocalesOf' of undefined` | 1 | `js/web/intl/intl.test.ts` |
| `TypeError: cannot read property 'update' of undefined` | 1 | `regression/issue/28024.test.ts` |
| `TypeError: cannot set property 'onmessage' of undefined` | 1 | `js/web/workers/message-port-pipe.test.ts` |
| `TypeError: class constructors must be invoked with 'new'` | 1 | `js/node/string_decoder/string-decoder.test.js` |
| `TypeError: expected depth to be greater than or equal to 0, got -1` | 1 | `js/web/console/console-log.test.ts` |
| `TypeError: formData() is not supported in bun-wasm` | 1 | `regression/issue/27478.test.ts` |
| `TypeError: no setter for property` | 1 | `js/bun/util/bun-main.test.ts` |
| `TypeError: not an object` | 1 | `js/node/process/call-constructor.test.js` |
| `TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received an instance of Object` | 1 | `js/node/fs/fs-promises-writeFile-async-iterator.test.ts` |
| `TypeError: value is not disposable` | 1 | `js/bun/test/mock-disposable.test.ts` |
<!-- first-errors:end -->

## Root causes with more than one file

These counts describe the recorded baseline blocker. Several leading causes
have since shipped, including lint, format, archives, transpilation, fake timers,
workers, and installer workspaces. Their remaining assertions need a new
diagnosis. The manifest also records single-file causes. The table keeps the
unresolved remainder visible instead of inventing diagnoses for it.

<!-- causes:start -->
| Baseline root cause | Files | Example |
| --- | --- | --- |
| Unresolved first blocker; a matcher signature does not establish its cause | 213 | `cli/bunfig-test-options.test.ts` |
| bun lint has no command implementation | 22 | `cli/lint/bun-rules.test.ts` |
| External registry access is blocked by the loopback-only census | 18 | `cli/install/bunx-directories-bin.test.ts` |
| Bun.Transpiler is absent | 14 | `js/bun/resolve/lower-using-bun-target.test.ts` |
| Bun.Archive is absent | 13 | `cli/install/GHSA-pfwx-36v6-832x.test.ts` |
| Bun.version_with_sha is absent and breaks harness version normalization | 13 | `cli/install/nested-overrides.test.ts` |
| jest.useFakeTimers, useRealTimers and setSystemTime are absent | 12 | `js/bun/test/fake-timers/sinonjs/issue-187.test.ts` |
| The global Web Worker constructor is absent | 11 | `js/bun/util/bun-isMainThread.test.js` |
| bun fmt has no command implementation | 10 | `cli/format/bunfig.test.ts` |
| The installer rejects manifests with workspaces | 9 | `cli/install/bun-install-link-path.test.ts` |
| Test report paths are relative to the working directory instead of the source root | 9 | `cli/test/claudecode-flag.test.ts` |
| HTMLRewriter is absent | 8 | `js/web/html/html-rewriter-doctype.test.ts` |
| toThrow does not await a returned rejecting promise | 7 | `js/bun/test/expect.test.js` |
| Subprocess dispatch only supports the wasm Bun executable | 7 | `internal/build-rust-toolchain-probe.test.ts` |
| Bun.$ has no cwd, throws, nothrow or execution implementation | 7 | `js/bun/test/test-only.test.ts` |
| process.stdin lacks pipe and live Node readable behavior | 7 | `js/bun/memfd-disabled.test.ts` |
| Zstd stream constructors and compression functions are absent | 6 | `js/node/zlib/zlib-reset-race.test.ts` |
| Registry requests send the wrong npm Accept header | 5 | `cli/install/bun-install-offline.test.ts` |
| path.win32 uses POSIX algorithms instead of Windows path rules | 5 | `js/node/path/basename.test.js` |
| UDP and resolver datagram sockets have no host ABI | 5 | `js/bun/udp/udp_socket.test.ts` |
| Bun.cron and Bun.cron.parse are absent | 4 | `js/bun/cron/cron-local-time.test.ts` |
| The installer ignores existing npm, pnpm and Yarn lockfile migration | 4 | `cli/install/migration/migrate.test.ts` |
| Bun.markdown is absent | 4 | `js/bun/md/gfm-compat.test.ts` |
| bun run treats following runtime options as a filename | 4 | `cli/run/jsx-symbol-collision.test.ts` |
| Resolver errors say package instead of module and omit structured diagnostics | 4 | `cli/run/tsconfig-override.test.ts` |
| Bun.Terminal needs a PTY and termios host capability | 4 | `js/bun/terminal/terminal-platform-gaps.test.ts` |
| Test registration rejects the options-before-callback overload | 4 | `cli/install/bun-install-tarball-integrity.test.ts` |
| bun update is absent | 4 | `cli/install/bun-update-security-provider.test.ts` |
| Bun.WebView constructor and CDP client are absent | 4 | `js/bun/webview/webview-chrome-disconnect.test.ts` |
| expect.toBeWithin is absent | 4 | `js/bun/glob/match.test.ts` |
| Brotli compression and decompression are stubbed | 4 | `js/node/errors/error-code-messages.test.ts` |
| Bun.Image codec and resize API is absent | 3 | `js/bun/image/image-kernels.test.ts` |
| Runtime resolution does not auto-install package specifiers | 3 | `cli/install/bun-run-dir.test.ts` |
| Child IPC and process.send are unsupported | 3 | `js/bun/spawn/spawn.ipc.bun-node.test.ts` |
| Conditional and each test builders lose their modifier methods | 3 | `cli/run/run-autoinstall.test.ts` |
| Native FFI libraries and addon loading are unavailable | 3 | `js/bun/spawn/spawn-pipe-read-error-leak.test.ts` |
| Installer resolution does not handle local file dependency graphs | 3 | `cli/install/bun-remove.test.ts` |
| Filesystem wrappers lose Node error code and path fields | 3 | `js/bun/io/bun-write.test.js` |
| HTTP and WebSocket serializers lowercase caller-visible header names | 3 | `js/web/websocket/websocket-utf16-headers.test.ts` |
| The installer rejects --linker=hoisted while accepting the spaced form | 3 | `cli/install/bun-install-backends.test.ts` |
| Package resolution requires dist.integrity or dist.shasum | 3 | `cli/install/bun-security-scanner-matrix-with-node-modules.test.ts` |
| Installer lacks --lockfile-only mode | 3 | `cli/install/lockfile-only.test.ts` |
| Bun.ModuleGraph is absent | 3 | `js/bun/module-graph/module-graph-io.test.ts` |
| assert.partialDeepStrictEqual is absent | 3 | `js/node/assert/assert.test.cjs` |
| bunfig preloads and preload-defined extensions are not applied | 3 | `cli/run/preload-test.test.js` |
| S3Client and Bun.s3 are absent | 3 | `js/bun/s3/s3-connection-close.test.ts` |
| process.stdout end, drain and async iteration contracts are incomplete | 3 | `js/node/process/process-stdout-write-after-end.test.ts` |
| Body and Node stream consumers release locks that Bun retains | 3 | `js/web/streams/readable-stream-blob-consumed.test.ts` |
| Bun.unsafe.gcAggressionLevel is native GC test control | 3 | `js/bun/glob/scan.test.ts` |
| AbortController, EventTarget and CustomEvent lack their web toStringTag | 3 | `js/deno/abort/abort-controller.test.ts` |
| bun x and bunx execution are absent | 3 | `cli/install/bunx-concurrent.test.ts` |
| CI detection does not reject test.only | 2 | `cli/env/ci-info.test.ts` |
| CommonJS namespace interop exposes the wrong default and __esModule shape | 2 | `js/bun/resolve/esModule-annotation.test.js` |
| Standalone compilation and native bytecode tooling are absent | 2 | `cli/inspect/compile-bytecode-tooling.test.ts` |
| bun:internal-for-testing.cssInternals.minifyTest is absent | 2 | `js/bun/css/angle-serialization-hang.test.ts` |
| Runtime TypeScript loading does not emit the requested legacy decorator behavior | 2 | `regression/issue/10887.test.ts` |
| Startup does not load the requested dotenv files | 2 | `cli/run/no-envfile.test.ts` |
| Dynamic data URL modules are resolved as package names | 2 | `cli/run/syntax.test.ts` |
| Eval mode does not provide native Bun's TSX and React evaluation behavior | 2 | `cli/run/run-eval.test.ts` |
| Matcher failures omit the custom expectation label | 2 | `js/bun/test/expect-failure-message-angle-brackets.test.ts` |
| expect.extend silently accepts non-callable entries | 2 | `js/bun/test/expect-extend.test.js` |
| Native fetch ignores explicit proxy selection | 2 | `js/bun/perf/linker-order.test.ts` |
| Request body normalization stringifies FormData instead of encoding multipart data | 2 | `regression/issue/07917/7917.test.ts` |
| bun info and why are absent | 2 | `cli/install/bun-info.test.ts` |
| Installer rejects --backend and --backend=hardlink | 2 | `cli/install/bun-workspaces-self-contained.test.ts` |
| The installer only implements the hoisted linker | 2 | `cli/install/isolated-install.test.ts` |
| Installer does not parse --cpu, --os or --libc overrides | 2 | `cli/install/bun-install-cpu-os.test.ts` |
| Installer does not honor scoped npmrc registry URL paths | 2 | `cli/install/bun-install-pathname-trailing-slash.test.ts` |
| expect.pass and expect.fail are absent | 2 | `regression/issue/07324.test.ts` |
| bun patch and prune commands are absent | 2 | `cli/install/bun-patch.test.ts` |
| bun pm migrate is absent | 2 | `cli/install/migration/npm-arborist.test.ts` |
| Native CPU and heap profiler CLI output is unavailable | 2 | `cli/heap-prof.test.ts` |
| The test runner ignores retry and rerun-each flags | 2 | `cli/test/rerun-each.test.ts` |
| Error frames and diff printing diverge from Bun's assertion report | 2 | `js/bun/test/printing/diffexample.test.ts` |
| bun:test.onTestFinished is absent | 2 | `js/bun/test/test-on-test-finished.test.ts` |
| Bun.sliceAnsi is absent | 2 | `js/bun/util/sliceAnsi-fuzz.test.ts` |
| BuildError diagnostics do not expose line and column positions | 2 | `js/bun/css/invalid-utf8-column.test.ts` |
| Error stacks are not remapped through the expected source maps | 2 | `js/bun/sourcemap/external-sourcemap-stack-leak.test.ts` |
| Subprocess.resourceUsage returns undefined | 2 | `cli/lint/react-compiler.test.ts` |
| domainToASCII and domainToUnicode accept invalid domain input | 2 | `js/node/url/url-domain-ascii-unicode.test.js` |
| vm.SourceTextModule is absent | 2 | `js/node/vm/sourcetextmodule-leak.test.ts` |
| Bun.wrapAnsi is absent | 2 | `js/bun/util/wrapAnsi.npm.test.ts` |
<!-- causes:end -->

## Current reproduction and selected fix

A fresh build at main `2ea5c62f` reran all 720 files on QuickJS with the pinned
dependencies, loopback networking, a 15-second file deadline, and a 2,000 ms
test deadline. It records 82 fully passing files, 8,474 observed passes, 12,800
observed failures, and 22 file timeouts. This is a current diagnostic replay,
not a before/after claim for this PR.

The replay includes all 44 files whose original recorded test was
`<collection/hook/exit; no named failure>`. Representative collection results
are as follows.

| File | Current observation |
| --- | --- |
| `cli/install/GHSA-pfwx-36v6-832x.test.ts` | Archive construction now works; ten install/integrity assertions fail. |
| `js/bun/console/console-write.test.ts` | Collection still rejects a missing conditional test builder. |
| `js/bun/test/expect-type-doctest.test.ts` | Collection still lacks the `expectTypeOf` export. |
| `regression/issue/29264.test.ts` | Collection rejects the options-before-callback test overload. |
| `js/web/web-globals.test.js` | Collection still lacks `PerformanceMark`. |

The selected shared cause is the Windows path namespace. Five files in the
720-file selection first fail on its lexical rules. Two more first fail on the
same module's boxed-string conversion and missing `_makeLong` alias. The broader
path selection includes these causes under other scoreboard categories.
`path.win32` previously copied the POSIX
functions and changed only `sep` and `delimiter`. That breaks drives, UNC roots,
backslashes, and Windows relative paths on every engine. Those lexical rules
do not require a Windows host or a new process capability.

The fix uses Bun's existing Rust `bun_node_path` crate for lexical operations.
Original TypeScript adapters provide guest cwd, argument conversion, resolution,
relative paths, formatting, and namespace conversion. UTF-16 code units remain
intact across the native boundary. The same module also exposes `matchesGlob`
through the existing Bun glob native. No upstream tests or snapshots change.

The larger remaining shell and stdin groups need process or shell execution
work. This change stays out of the process layer that the active step 7b track
is modifying. The old leading
groups already implemented on main are not counted as new opportunities here.

## Measurements

The fixed selection has 19 path files. The after rows come from a fresh
101-file focused replay, filtered to these exact paths. Suite revision, runner, dependencies,
network policy, and deadlines match the before rows. Each engine retains every
previously passing path file and every observed path pass. Timing is not compared.

<!-- measurements:start -->
| Engine | Fully passing files before / after | Observed passes before / after | Failures before / after | Timeouts before / after |
| --- | --- | --- | --- | --- |
| quickjs | 5 / 17 | 74 / 123 | 50 / 1 | 0 / 0 |
| jsc | 5 / 17 | 74 / 123 | 50 / 1 | 0 / 0 |
| browser | 5 / 17 | 74 / 123 | 50 / 1 | 0 / 0 |
<!-- measurements:end -->

Regenerate the compact evidence and table from the retained raw JSON with
`node scripts/group-suite-category-d.ts --results /work/reports/bun-wasm-category-d-runtime-semantics`.
Normal generation and `--check` then use the committed compact evidence.

The remaining failure is `js/node/path/resolve.test.js`, whose Windows
drive-relative child-process test cannot launch at guest cwd `/`.
`posix-relative-on-windows.test.js` is skip-only on this platform. Neither is
counted as fully passing. No path file times out.

### Previously passing controls

The control selection contains the 82 files that fully passed the fresh
unchanged-main QuickJS replay of the original 720 rows. Each engine's focused
job includes those exact 82 files plus the 19 path files. The jobs use separate
heavy-wrapper reservations. These controls test for regressions; gains that
already shipped on main are not attributed to this path change.

| Engine | Initially fully passing controls | Observed passes | Failures | File timeouts |
| --- | --- | --- | --- | --- |
| QuickJS | 82/82 | 1,472 | 0 | 0 |
| JSC | 81/82 | 1,471 | 1 | 0 |
| Browser | 71/82 | 1,275 | 14 | 5 |

Matched unchanged-main checks and the same-artifact rechecks for every
initially failing control are recorded in
[category-d-regression-results.json](category-d-regression-results.json).
The initial results remain visible even when a recheck passes.
JSC's initial failure reported RSS growth of 34.44 MB in the worker-context
leak assertion. The frozen main artifact and unchanged current artifact both
pass its isolated recheck. No leak-freedom claim follows from that outcome.

All 11 initial browser losses also fail with the frozen unchanged-main browser
artifact. Five are file timeouts in `cli/format/{bunfig,glob,oxfmt-cli/oxfmt-cli}`
and `cli/lint/{glob,hints}`. The other six files are
`cli/install/test-dev-peer-dependency-priority.test.ts` and regression issues
11793, 24387, 28170, 36577, and 40561. Their install, child-output, snapshot, and
individual-test deadline observations remain outside this path fix.
The same 11 browser files fail again with the unchanged current artifact,
with the same five file timeouts. There is no reproduced new file-level
control failure. The raw baseline and recheck logs preserve exact diagnostics.

Only the 101 measured files are eligible for failure-index updates. The
refresh preserves every unmeasured row byte-for-byte at the field level.
Full-census summaries and tables retain the previous census. The coordinator
deferred the full scoreboard refresh to a separate census run.

## Reproduction and retained evidence

Run the focused selection on each built engine through the heavy wrapper.

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 --timeout 15 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-path-quickjs.json --log-dir /work/tmp/bun-wasm-path-logs \
  js/node/path
```

Repeat with `--engine jsc` and `--engine browser`. To reproduce the controls,
use the 82 non-path entries in `partial-summary.json` as explicit suite paths,
with the same options and one separately queued job per engine.
`category-d-regression-results.json` names the initially failing subset and
records its frozen-main and same-artifact rechecks. The fixture
`scripts/test.sh --no-build --engine <engine> node-path-native` covers Windows
roots, drives, namespaces, long paths, lone surrogates, and boxed-string
conversion. The original wasm fails its first basename assertion.

Raw JSON, per-file logs, build and gate output, hashes, and the complete
720-file diagnostic replay are retained under
`/work/reports/bun-wasm-category-d-runtime-semantics/`. The coordinator owns
removal after accepting or reproducing this PR. Private Cargo targets, suite
snapshots, guest artifacts, servers, and the worktree are removed by this lane.
