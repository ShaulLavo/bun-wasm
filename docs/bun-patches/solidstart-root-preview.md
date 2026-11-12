# SolidStart root previews

Classification: original local adapter.

`scripts/goals-matrix/catalog.ts` selects the existing origin-root preview adapter
for the local SolidStart starter. It passes the allocated guest port to Vinxi's
development and production commands. No SolidStart or Vinxi source is copied or
patched. The starter retains `@solidjs/start` 1.3.2 and `vinxi` 0.5.11.

SolidStart serves the page at `/`, but a path-prefixed browser preview loads it at
`/__preview/<port>/`. The latter leaves the rendered counter unhydrated and tries
to open Vinxi's internal Vite socket outside the guest. The origin-root adapter
keeps routing and the guest's internal socket aliases in the same preview owner.
The regression checks the actual goals URL and both allocated-port commands.

The template's development and production scripts omit their fixed `--port 5173`.
Vinxi receives the allocated port once. Repeated flags made development fall
back to port 3000, which was already occupied on the test host. Separate
regressions check each script's composed command before the real browser run.

Vinxi analyzes file routes with esbuild's synchronous API. On the in-guest
engines, esbuild's default worker path tries to post a SharedArrayBuffer that
cannot be cloned. The development and build commands set the upstream-supported
`ESBUILD_WORKER_THREADS=0` before Vinxi imports esbuild. They still use its real
synchronous service and transform API. Production start is unchanged.

The real browser diagnostic resolves Vinxi's esbuild dependency at
`node_modules/vinxi/node_modules/esbuild/lib/main.js` to esbuild-wasm 0.25.12. Its
worker guard reads `process.env.ESBUILD_WORKER_THREADS !== "0"`. The focused command
regressions use an explicit, test-only esbuild 0.28.2 dependency and call
`transformSync` without mocking the API. This is not a same-version reproduction.
They check that each template
command overrides an inherited worker setting before loading esbuild. No shared
runtime, global environment, or generic esbuild default-mode test changes.
