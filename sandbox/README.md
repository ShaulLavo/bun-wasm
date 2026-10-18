# sandbox: Bun's dev server in your browser

The sandbox edits a plain app in an in-memory filesystem and runs `bun ./index.html`
in a worker. Choose React or vanilla TypeScript in the template picker. Both templates
use Bun's HTML bundler, incremental graph, HMR client, and error overlay.

The React template uses Bun's built-in Fast Refresh. The vanilla template saves its
counter through `import.meta.hot.data` and accepts module updates without a framework.
Each template keeps its own edits across engine switches and page reloads.

## Build and run

```sh
cd sandbox
bun install
bun run build
bun run preview
node tests/hmr-check.mjs http://127.0.0.1:4173/
```

The build needs `../dist/bun.wasm`, `../dist/bun-browser.wasm`, and
`../dist/bun-jsc.wasm`. The preview server sends the cross-origin isolation headers
needed by the worker's shared-memory networking.

`build.ts` packages the page and the shared worker, filesystem, WASI shim, and service
worker from `web/src`. It writes `template.json` and `template-vanilla.json` with the
starter source files. React's dependency sources come from a native `bun install`.
The site build does not ship a prebuilt React bundle. Bun compiles React in the browser.

## How edits reach the app

The editor writes the page's filesystem after a 350 ms pause. It also sends the changed
file through `NetHelper.changeFile`, whose shared ring updates the worker's filesystem
even while wasm is running. The runtime checks Bun's watched files every 100 ms and
passes changed paths to the native incremental graph.

Bun sends its binary HMR messages through `/_bun/hmr`. Preview HTML includes a transport
shim because service workers cannot intercept WebSockets. The shim carries the existing
WebSocket protocol through a MessagePort and the virtual TCP connection. The same route
works in an iframe and in a separate preview tab.

Bun's generated client applies JavaScript and CSS updates, performs React Fast Refresh,
and displays build errors in its `bun-hmr` overlay. The sandbox has no app-level dev
server or custom HMR client.

## Dependency cache

After the first preview loads, the page saves the native dependency graph from
`/_bun/deps-cache` in Cache Storage. Before another worker starts, it restores that blob
to `/.bunwasm/deps-cache`. The cache key includes the engine, wasm build, and template
build. Editing a dependency manifest or a dependency file disables restoration for that
project. The Rust driver validates and restores the compiled dependency modules.

`tests/startup-cache.mjs` checks cold compilation, cached restarts and reloads,
corrupt-cache recovery, manifest edits, and HMR after a cached restart.
