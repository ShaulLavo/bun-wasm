# sandbox: Bun's dev server in your browser

The sandbox edits a project in an in-memory filesystem and runs its package scripts
in a worker. The picker includes every shared framework template, whether it works
yet or not. Each template keeps its own edits across engine switches and reloads.

The React, Vue, Svelte and vanilla starters use Vite. Other templates use their
framework's development server. See [sandbox deployment](sandbox-deployment.md)
for the command that publishes current main to the owner's sandbox.

## Build and run

```sh
cd sandbox
bun install
bun run build
bun run preview
bun tests/hmr-check.ts http://127.0.0.1:4173/
```

The build needs `../dist/bun.wasm`, `../dist/bun-browser.wasm`, and
`../dist/bun-jsc.wasm`. The preview server sends the cross-origin isolation headers
needed by the worker's shared-memory networking.

`build.ts` packages the page, workers, engines and source payloads for every picker
entry. Dependencies install in the browser and the framework compiles the project
there. The site build does not ship a prebuilt React bundle.

## Startup and edits

The sandbox loads the selected source payload into its project filesystem, runs
`bun install`, and then runs `bun run dev`. Dependency installation and server
output appear in the terminal. A failed framework remains available in the picker.

The editor saves changes to the project filesystem. The framework's watcher and
HMR client handle rebuilding, refreshing the preview and showing compilation
errors. The preview transport carries HTTP and WebSocket traffic between the
framework server and its iframe through the browser runtime.
