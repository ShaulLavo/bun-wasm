# Framework replay after the ws builtin

Measured on 2026-10-16 with unchanged pinned project fixtures and offline
registry digest `bff1211cea1f8aed1dacd80b53b81b8a75a1a63987c8b053e426021269389b59`.
The private integration commit is `f7659376c594a5f6f6bf7a8035be69a5b23a2281`;
its exact full revision is also retained in the execution provenance. Cargo added
two already-locked workspace dev dependencies during the build; the retained
`app-integration-lock.patch` records that delta without changing versions. It combines
the TCP/ws commits with Rollup prerequisite
`97e67614b2a4cd6eaca6d8ef339ce1af30252802`. Rollup changes are not part of the
ws builtin PR.

Five formerly ws-blocked projects ran on all three native engines. Vite React
also ran in the browser playground on all three engines. Native execution has
15 install passes and 27 command failures. Playground execution has three
install passes and six command failures. There are no blocked stages, missing
registry records, corrupt records, or successful complete app commands.

The earlier Rollup comparison stopped on the missing ws import in 18 native
QuickJS/JSC commands and four playground commands. None of those 22 commands
stops there now. Later failures remain:

| Workload | QuickJS | JSC | Browser engine |
| --- | --- | --- | --- |
| Vite vanilla, React, Vue builds | esbuild rejects linux wasm32 | Same | Module-linker syntax error |
| Vite vanilla, React, Vue dev | No output before exit or deadline | Same | Same syntax error |
| Astro build | Circular Fragment export | Missing Http2ServerResponse export | Same syntax error |
| SvelteKit dev and build | esbuild config-bundling stack | Same | Same syntax error |
| Playground Vite React dev | Exits 0 before HTTP/DOM assertion | Same | Same syntax error |
| Playground Vite React build | No captured diagnostic | Same | Same syntax error |

The esbuild logs identify `node_modules/esbuild/lib/main.js:1651` and report
`Unsupported platform: linux wasm32 LE`. SvelteKit logs contain the same
`pkgAndSubpathForCurrentPlatform` and `ensureServiceIsRunning` stack, without
an error message. Astro's QuickJS log names
`/node_modules/astro/dist/runtime/server/index.js`; JSC names `node:http2`.
The browser linker issue is the existing import-method rewrite recorded in the
Rollup comparison.

The original classifier omitted plugin-prefixed platform errors and plain
linker messages. A focused regression now covers those forms. Execution reports
are retained unchanged. `app-classified.json` separately records the corrected
labels, the classifier hash, source-report hashes and log hashes. This changes
failure labels only; it does not rerun or upgrade pass assertions.

## Reproduce

Build an exclusive integration checkout containing the TCP/ws commits and the
Rollup prerequisite. Use private Cargo target directories and the machine's
admission wrapper, then run:

```sh
scripts/app-matrix.sh --apps=vite-vanilla,vite-react,vite-vue,astro,sveltekit \
  --engines=quickjs,jsc,browser --hosts=native --timeout=90 \
  --cache=/work/cache/bun-wasm-app-matrix --output=/work/tmp/bun-wasm-ws-native-new
scripts/app-matrix.sh --apps=vite-react --engines=quickjs,jsc,browser \
  --hosts=playground --timeout=90 --cache=/work/cache/bun-wasm-app-matrix \
  --output=/work/tmp/bun-wasm-ws-playground-new
```

Raw records and logs remain under
`/work/reports/bun-wasm-tcp-2026-10-16/apps-native/` and `apps-playground/` until
coordinator review is accepted. Both runners report cleanup complete, and their
loopback namespace, project copies, browser contexts and servers are removed.
