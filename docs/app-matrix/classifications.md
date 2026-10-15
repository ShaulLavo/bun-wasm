# Retained census classifications

Regenerated from /work/reports/bun-wasm-app-matrix-2026-10-15. This updates failure categories only. Original pass assertions predate the strengthened harness and are not revalidated here.

Reproduce with `bun scripts/app-matrix/reclassify.mjs <evidence-directory>`.

- native/results.json SHA-256 b2e19081702b2216ed2a6fe5cae3ea3bd2b3940f47f7ea9a50d7cbb20db61268
- playground-light/results.json SHA-256 9b9a1b8b1bf1d97d8cb74dcad71e3a997163d715914e06cb31aa85354f563dea

| App | Engine | Host | Stage | Status | Category | Diagnostic / assertion | Passes on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| express | quickjs | native | start | fail | f | start: TypeError: not a function | browser |
| express | jsc | native | start | fail | d | start: TypeError: callSite.getFileName is not a function. (In 'callSite.getFileName()', 'callSite.getFileName' is undefined) | - |
| koa | quickjs | native | start | fail | d | start: TypeError: not a function | - |
| koa | jsc | native | start | fail | d | start: TypeError: callSite.getFileName is not a function. (In 'callSite.getFileName()', 'callSite.getFileName' is undefined) | - |
| koa | browser | native | start | fail | d | server: No output before deadline | - |
| vite-vanilla | quickjs | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vanilla | quickjs | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vanilla | jsc | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vanilla | jsc | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vanilla | browser | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vanilla | browser | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | quickjs | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | quickjs | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | jsc | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | jsc | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | browser | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | browser | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vue | quickjs | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vue | quickjs | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vue | jsc | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vue | jsc | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vue | browser | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-vue | browser | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| astro | quickjs | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| astro | jsc | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| astro | browser | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| sveltekit | quickjs | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| sveltekit | quickjs | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| sveltekit | jsc | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| sveltekit | jsc | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| sveltekit | browser | native | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| sveltekit | browser | native | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| next | quickjs | native | dev | fail | d | dev: ReferenceError: module is not defined | - |
| next | quickjs | native | build | fail | d | build: ReferenceError: module is not defined | - |
| next | quickjs | native | start | blocked | d | build: ReferenceError: module is not defined | - |
| next | jsc | native | dev | fail | d | dev: ReferenceError: module is not defined | - |
| next | jsc | native | build | fail | d | build: ReferenceError: module is not defined | - |
| next | jsc | native | start | blocked | d | build: ReferenceError: module is not defined | - |
| next | browser | native | dev | fail | d | server: [?25h | - |
| next | browser | native | build | fail | d | build: unhandledRejection Error: No such module: fs | - |
| next | browser | native | start | blocked | d | build: unhandledRejection Error: No such module: fs | - |
| prisma | reference | native | generate | fail | d | generate: Error: Failed to fetch sha256 checksum at http://127.0.0.1:36753/blocked-prisma-engines/all_commits/272a37d34178c2894197e17273bf937f25acdeac/debian-openssl-3.0.x/schema-engine.gz.sha256 - 403 Forbidden | - |
| prisma | reference | native | schema | blocked | d | generate: Error: Failed to fetch sha256 checksum at http://127.0.0.1:36753/blocked-prisma-engines/all_commits/272a37d34178c2894197e17273bf937f25acdeac/debian-openssl-3.0.x/schema-engine.gz.sha256 - 403 Forbidden | - |
| prisma | reference | native | query | blocked | d | generate: Error: Failed to fetch sha256 checksum at http://127.0.0.1:36753/blocked-prisma-engines/all_commits/272a37d34178c2894197e17273bf937f25acdeac/debian-openssl-3.0.x/schema-engine.gz.sha256 - 403 Forbidden | - |
| prisma | quickjs | native | install | fail | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | quickjs | native | generate | blocked | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | quickjs | native | schema | blocked | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | quickjs | native | query | blocked | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | jsc | native | install | fail | d | install: memory allocation of 13650304 bytes failed | - |
| prisma | jsc | native | generate | blocked | d | install: memory allocation of 13650304 bytes failed | - |
| prisma | jsc | native | schema | blocked | d | install: memory allocation of 13650304 bytes failed | - |
| prisma | jsc | native | query | blocked | d | install: memory allocation of 13650304 bytes failed | - |
| prisma | browser | native | install | fail | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | browser | native | generate | blocked | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | browser | native | schema | blocked | d | install: memory allocation of 16777216 bytes failed | - |
| prisma | browser | native | query | blocked | d | install: memory allocation of 16777216 bytes failed | - |
| typescript | quickjs | native | check | fail | f | TypeError: cannot read property 'tryEnableSourceMapsForHost' of undefined | browser |
| typescript | jsc | native | check | fail | c | TypeError: undefined is not an object (evaluating 'sys.tryEnableSourceMapsForHost') | - |
| eslint | quickjs | native | lint | fail | d | lint:     at requireFrom (bun-wasm:bootstrap:548:12) | - |
| eslint | jsc | native | lint | fail | d | lint: runMain@bun-wasm:bootstrap:634:21 | - |
| eslint | browser | native | lint | fail | d | lint:     at loadModule (bun-wasm:bootstrap:497:7) | - |
| prettier | quickjs | native | check | fail | f | error: Cannot find module '../internal/legacy-cli.mjs' from '<input>' | jsc |
| prettier | browser | native | check | fail | c | error: Cannot find module '/work/worktrees/bun-wasm/app-matrix/web/internal/legacy-cli.mjs' imported from /work/worktrees/bun-wasm/app-matrix/web/src/engine-host.js | - |
| vitest | quickjs | native | test | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vitest | jsc | native | test | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vitest | browser | native | test | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | quickjs | playground | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | quickjs | playground | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | jsc | playground | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | jsc | playground | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | browser | playground | dev | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| vite-react | browser | playground | build | fail | a | error: Your current platform "linux" and architecture "wasm32" combination is not yet supported by the native Rollup build. Please use the WASM build "@rollup/wasm-node" instead. | - |
| prettier | quickjs | playground | check | fail | f | error: Cannot find module '../internal/legacy-cli.mjs' from '<input>' | jsc |
| prettier | browser | playground | check | fail | d | Missing output All matched files use Prettier code style | - |
