# sandbox: a React app with hot reload, all in bun.wasm

A small StackBlitz-style page: a file tree, a CodeMirror editor, a live preview and the dev server's
terminal. The project is a React 19 app in the in-memory filesystem, and its dev server is a
`Bun.serve` script (`template/dev.ts`) running in bun.wasm in a worker. No backend: the static
files are the whole site.

## Build and run

```sh
cd sandbox
bun install
bun run build                 # -> sandbox/dist (needs ../dist/*.wasm, see the root README)
bun run preview               # http://127.0.0.1:4173, cross-origin isolated
node tests/hmr-check.mjs http://127.0.0.1:4173/   # the HMR checklist, every engine, Chromium + iPhone WebKit
```

`build.ts` bundles the page with the shared modules from `web/src/` (worker, WASI shim, in-memory
filesystem, networking, service worker), gzips each engine's wasm, and writes `template.json`: the
files under `template/` plus the node_modules files the app needs, taken from a native
`bun install` of `template/package.json` (React's development builds, react-refresh, scheduler).

The header's engine picker reloads the page with `?engine=browser|quickjs|jsc`; edits survive in
sessionStorage. The page must be cross-origin isolated (COOP/COEP), like the playground.

## How a change reaches the preview

1. **Start.** The page seeds the filesystem from `template.json` and runs `bun dev.ts` in
   `/home/user/app` (`web/src/runner.ts`). dev.ts bundles the dependencies once with `Bun.build`
   (splitting on, one ES module per import: `react`, `react-dom/client`, `react-refresh/runtime`, …)
   and listens on port 5173. The preview iframe opens `./__preview/5173/`, which the service worker
   forwards to the guest server (see web/README.md, "Networking").
2. **Serving.** `index.html` gets an import map for those dependency modules and
   `<script type="module" src="/@hmr/client.js">` ahead of the app. Each source file is
   transpiled on request by `Bun.build` with `external: ["*"]` and `reactFastRefresh: true`, so
   components call `$RefreshReg$`/`$RefreshSig$`; relative imports are rewritten to
   `/src/App.tsx?t=<version>` (CSS: `?import&t=<version>`, served as a module that fills a
   `<style>`). dev.ts keeps the import graph and notes which modules export only components.
3. **Editing.** The editor saves 350 ms after typing stops: the page writes its own filesystem
   (the next run starts from it) and sends `POST /@hmr/update {path, text}` to the dev server
   through the same networking helper the service worker uses (the page itself is outside the
   service worker's scope). The guest writes the file into its filesystem copy and rebuilds it.
4. **Pushing.** dev.ts walks up the import graph from the changed file to the nearest modules that
   export only components, bumps their versions and queues an event. The HMR client long-polls
   `GET /@hmr/events?since=<id>` (`Bun.serve` here buffers whole responses, so no SSE), imports
   the new module URLs and calls `performReactRefresh()`: React swaps the components and keeps
   their state. CSS events re-import the CSS module. A file with no component boundary above it
   (main.tsx) reloads the page.
5. **Errors.** A failed build is reported in the POST's answer and as an event; the client shows
   an overlay with Bun's message and the offending line, and removes it on the next good build.

dev.ts uses only Bun's APIs, so `bun dev.ts` in a copy of `template/` (after `bun install`) runs
the same server on native Bun.
