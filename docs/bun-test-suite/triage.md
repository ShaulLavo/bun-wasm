# Failure groups

Each row describes the first observed blocker. Source inference is provisional; it is not proof that all tests in the file need the same fix. Full assignments and confidence are in [failures.tsv](failures.tsv).

| Category | First blocker / topic | Files | Example file | Test | Error |
|---|---|---|---|---|---|
| a | native addons, threads, processes, watching or OS-only facilities | 160 | cli/bun.test.ts | bun > per-stream color detection > piped stdout stays plain when stderr is a tty | error: bun:ffi.dlopen is not supported in bun-wasm: no native libraries in wasm |
| a | network operations beyond the current host ABI | 4 | js/bun/dns/resolve-dns.test.ts | dns > lookup() [backend: system] > localhost > {"options":{"backend":"system"}} | error: Bun.dns.lookup is not supported in bun-wasm: WASI has no network access |
| b | CLI options, environment, cwd and script launching | 64 | cli/console-depth.test.ts | console depth > default console depth should be 2 | error: Bun.spawn is not supported in bun-wasm: WASI has no processes |
| b | bundling, compiling, generated program output | 90 | bundler/bun-build-api.test.ts | Bun.build > css works | error: expect(received).toBe(expected) |
| b | network server/client behavior in a child program | 34 | js/bun/dns/dns-prefetch.test.ts | a failed connect evicts the host's DNS cache entry | error: Bun.spawn is not supported in bun-wasm: WASI has no processes |
| b | package manager commands and lifecycle scripts | 57 | cli/install/bun-info.test.ts | bun info > bun info (main command) > should display package info for latest version | error: Bun.spawn is not supported in bun-wasm: WASI has no processes |
| b | process lifecycle, exit and signal handling | 147 | bake/hmr-socket-protocol.test.ts | a duplicate testing-batch frame (H) during an in-flight bundle closes the socket instead of aborting | error: Bun.spawn is not supported in bun-wasm: WASI has no processes |
| b | runtime behavior or regression fixture in a child program | 186 | bake/app-options.test.ts | Bun.serve({ app }) rejects wrong-typed framework options | error: Bun.spawn is not supported in bun-wasm: WASI has no processes |
| b | test runner output, hooks, assertions and exit status | 116 | bake/deinitialization.test.ts | dev server deinitializes itself | error: expect(received).toBeUndefined() |
| c | Bun's fs/promises.exists extension | 23 | cli/install/bun-add-filter.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'exists' in module 'node:fs/promises' |
| c | boxed String paths from harness.tempDir | 29 | bake/dev/response-to-bake-response.test.ts | Response -> import { Response } from 'bun:app' transform in server components | TypeError: The "paths[0]" property must be of type string, got object |
| c | setup: pre-existing host listener occupies the suite's default port 3000 | 5 | integration/bun-types/fixture/serve-types.test.ts | basic | error: Failed to start server. Is port 3000 in use? |
| c | test runner helpers or matcher methods | 2 | js/bun/module-graph/module-graph-isolation.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'setSystemTime' in module 'bun:test' |
| c | uninstalled suite dependency, setup work before API triage | 159 | bundler/transpiler/decorator-metadata.test.ts | <collection/hook/exit; no named failure> | error: Cannot find package 'reflect-metadata' from '/bun/test/bundler/transpiler/decorator-metadata.test.ts' |
| d | Bun TCP socket callbacks, current host ABI already supports TCP | 12 | cli/run/sql-preconnect.test.ts | --sql-preconnect > should attempt to preconnect to PostgreSQL on startup | error: Bun.listen is not supported in bun-wasm: WASI has no network access |
| d | Bun shell parser and execution | 41 | cli/run/shell-keepalive.test.ts | shell should stay alive while a builtin command is in progress | error: Bun.spawn is not supported in bun-wasm: WASI has no processes |
| d | ES module mocking and loader invalidation | 4 | js/bun/test/mock/6874/A.test.ts | <collection/hook/exit; no named failure> | error: mock.module() is not supported in bun-wasm yet |
| d | HTTP/server/fetch/WebSocket semantics | 106 | js/bun/cookie/cookie.test.ts | Bun.Cookie validation tests > expires validation > accepts valid Date for expires | TypeError: not a function |
| d | Node's test API adapter | 26 | js/bun/perf_hooks/histogram.test.ts | <collection/hook/exit; no named failure> | error: No such built-in module: node:test |
| d | Node/Web stream semantics | 32 | internal/build-download-retry.test.ts | a download that fails on every attempt but the last still succeeds | BuildError: Failed to download after 10 attempts: http://127.0.0.1:44693/dep.tar.gz |
| d | SQLite API compatibility | 2 | js/bun/transpiler/transpiler-unsupported-loader.test.ts | <collection/hook/exit; no named failure> | TypeError: not a function |
| d | TLS or HTTP/2 | 59 | cli/install/npmrc.test.ts | <collection/hook/exit; no named failure> | TypeError: Cannot convert undefined or null to object |
| d | TOML/YAML/JSON5 APIs | 41 | cli/install/bun-install-native-binlink.test.ts | native binlink optimization > uses platform-specific bin instead of main package bin with linker hoi | TypeError: cannot read property 'stringify' of undefined |
| d | bundler options, plugins or compiler output | 13 | bundler/native-plugin.test.ts | <collection/hook/exit; no named failure> | SyntaxError: unexpected token in expression: '#ifndef' |
| d | crypto algorithms and WebCrypto | 24 | js/bun/crypto/cipheriv-decipheriv.test.ts | should encrypt & decrypt using update & final interface | error: crypto.createCipheriv is not supported in bun-wasm: only hashes, HMAC and random numbers are implemented |
| d | database, Redis or S3 clients | 111 | js/bun/image/image.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'S3Client' in module 'bun' |
| d | filesystem API semantics | 1 | js/bun/util/filesystem_router.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'FileSystemRouter' in module 'bun' |
| d | glob matching and filesystem traversal APIs | 27 | internal/install-ps1.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'Glob' in module 'bun' |
| d | portable caller source tracking used by the bundler test helper | 83 | bake/dev-and-prod.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'callerSourceOrigin' in module 'bun:jsc' |
| d | test runner/assertion or runtime semantics | 243 | cli/install/GHSA-pfwx-36v6-832x.test.ts | <collection/hook/exit; no named failure> | TypeError: not a function |
| d | timeout, first unblock and rerun without reducing it to an API verdict | 3 | js/node/buffer-indexof-worstcase.test.ts | <collection/hook/exit; no named failure> | <see JSON excerpt; no error line> |
| d | unresolved runtime/module semantics, inspect the recorded failure first | 48 | bundler/resolver/cache-invalidation.test.ts | resolver cache invalidation > extension resolution after file deletion | <see JSON excerpt; no error line> |
| e | private native-engine/compiler instrumentation has no portable equivalent | 104 | bake/framework-router.test.ts | <collection/hook/exit; no named failure> | SyntaxError: Could not find export 'frameworkRouterInternals' in module 'bun:internal-for-testing' |
| f | passes on browser | 4 | js/web/fetch/fetch-connection-header.test.ts | fetch Connection header > should default to keep-alive when no Connection header provided | error: expect(received).toBe(expected) |
| f | passes on browser, jsc | 2 | js/bun/jsc/webkit-upgrade-dbdca7545d.test.ts | WebKit dbdca7545d upgrade > Intl.DurationFormat keeps the minus sign of a fraction between -1 and 0  | TypeError: not a function |
