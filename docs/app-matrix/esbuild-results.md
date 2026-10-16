# Framework results after the esbuild wasm port

Measured 2026-10-16 with the unchanged published esbuild-wasm 0.25.12 distribution.
All 15 installs passed. Of 27 app commands, five production builds passed and
22 commands failed. No registry requests missed the local mirror.

| App | QuickJS build | JSC build | Browser-engine build |
| --- | --- | --- | --- |
| Vite vanilla 7.1.12 | Pass | Pass | SyntaxError, unexpected `.` |
| Vite React 7.1.12, React 19.1.1 | Pass | JSC native-value conversion trap | SyntaxError, unexpected `.` |
| Vite Vue 7.1.12, Vue 3.5.22 | Pass | Pass | SyntaxError, unexpected `.` |
| Astro 5.14.1 | Circular `Fragment` export | Missing `Http2ServerResponse` export | SyntaxError, unexpected `.` |
| SvelteKit 2.43.1 | Exit 1, no diagnostic | Exit 1, no diagnostic | SyntaxError, unexpected `.` |

All 12 dev-server rows failed. Vite vanilla, React, and Vue on QuickJS and JSC
returned no diagnostic before the harness stopped checking HTTP. This version
of the server harness does not record whether those rows exited or reached the
90-second deadline, so their first cause remains unconfirmed. SvelteKit on
QuickJS and JSC reached Vite's `fs.watch` call and reported
`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. All browser-engine dev rows reported the
same unexpected-dot syntax error as their builds.

The successful builds generated and checked the expected HTML and bundled
assets. These are app command results, not a claim that development servers or
complete framework workflows pass.

## Exact next blockers

- React on JSC transforms 22 modules, then the esbuild child executes wasm
  `unreachable` in `WTFCrashWithInfo`, `JSC::JSLock::unlock`,
  `JSC::JSLockHolder::~JSLockHolder`, `JSObjectSetProperty`, and
  `bunwasm_runtime::engine_jsc::from_val`. Vite then reports
  `[vite:esbuild-transpile] The service was stopped`. The crash is in the native
  value bridge; its cause is not established by this measurement.
- Astro on QuickJS reports `circular import: binding 'Fragment' is not
  resolvable in module '/node_modules/astro/dist/runtime/server/index.js'`.
- Astro on JSC reports `Export named 'Http2ServerResponse' not found in module
  'node:http2'.`
- SvelteKit dev on QuickJS and JSC reports `fs.watch is not supported in
  bun-wasm`, at Vite `dist/node/chunks/config.js:16359`.
- SvelteKit build on QuickJS and JSC exits 1 without stdout or stderr. Both
  records have `timedOut: false`.
- The browser engine exits 1 with `SyntaxError: Unexpected token '.'` for every
  requested framework command. The diagnostic does not identify a source file.

These failures need their own reproduction and root-cause work. The official
esbuild API and CLI fixture separately exercises transforms, source maps,
filesystem bundles, context rebuilds after an edit, asynchronous plugin
callbacks, and frozen reinstalls on all three engines.

## Provenance and replay

The matrix used the native launcher for QuickJS and JSC and the Node engine host
for the browser engine. The latter runs the wasm runtime with native V8
WebAssembly. This table does not describe playground-page results.

TCP [#14](https://github.com/ShaulLavo/bun-wasm/pull/14) and ws
[#16](https://github.com/ShaulLavo/bun-wasm/pull/16) were still open, so this was a
measurement-only integration checkout. It combined esbuild `3292c0d`, main
`84db5fe`, TCP `642eb0f9b127d7e6b6a3fd061dfbb088e8c477de`, and ws
`549032c31f71961527586c240afab18b35e71990`. The resulting integration commit is
`722d14b68600e20326c7752a4274ab6e0bcc7d76`. It is separate from the esbuild PR.
All 18 TCP, ws, stdin, and Node-command control fixtures passed across the three
engines before the matrix.

Run from the integration checkout, with its three dist artifacts and launcher:

```sh
source env.sh
scripts/app-matrix.sh \
  --apps=vite-vanilla,vite-react,vite-vue,astro,sveltekit \
  --engines=quickjs,jsc,browser --hosts=native --timeout=90 \
  --cache=/path/to/recorded-mirror --launcher=/path/to/bun-wasm \
  --output=/path/to/new-results
```

Use the machine's heavy-command wrapper for this command. The replay uses a
loopback-only network namespace and never contacts a public package registry.
The mirror has 1,294 entries; this run made 2,406 local requests with zero misses
and errors. Source, fixture, launcher, mirror, and wasm hashes are in the raw
`results.json`.

Raw logs and JSON are retained in
`/work/reports/bun-wasm-esbuild-2026-10-16/matrix-integration/`. The coordinator
owns removal after accepting the compatibility report.
