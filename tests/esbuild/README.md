# esbuild package checks

These checks run the published `esbuild-wasm@0.25.12` package unchanged. Install
`web` dependencies, build all three wasm artifacts and the native launcher, and
build the playground before running them through the machine's heavy wrapper.

```sh
MATRIX_CACHE=/path/to/offline-mirror bun tests/esbuild/run.mjs
MATRIX_CACHE=/path/to/offline-mirror bun tests/esbuild/browser.mjs
```

`BUN_WASM_LAUNCHER` selects a private native launcher. `ENGINES` selects a
comma-separated subset of `quickjs,jsc,browser`. The page checks default to
Chromium and WebKit. A positional browser argument selects one of them.
`ESBUILD_CHECKS` selects fixture names, with `check.cjs,sync.cjs,watch.cjs` as
the default.

The synchronous fixture uses the default environment without an
`ESBUILD_WORKER_THREADS` override. It checks all four synchronous APIs and the
package's errors for invalid syntax and synchronous plugins. The watch fixture
waits for its initial `onEnd`, edits the input, and waits for another `onEnd`
and updated output. After initial replies settle, it holds child stdin writes
until the service emits its first rebuild notification. This prevents an
incidental protocol reply from publishing the edit. Queued replies resume after
that notification and before cleanup. The fixture sends no rebuild request and
always disposes the context and stops esbuild. The same pause passes against the
published package under native Node. Initial builds have a 60-second bound and
edit rebuilds have a 30-second bound for the interpreted wasm engines.

Both runners use the app-matrix registry in offline replay mode. A mirror must
contain these two records, in addition to any existing esbuild metadata:

- `/esbuild-wasm`
- `/esbuild-wasm/-/esbuild-wasm-0.25.12.tgz`

An older shared mirror may lack them. The PR review-fix evidence retains the
two official records and their content-addressed objects in
`/work/reports/bun-wasm-esbuild-reviewfix-2026-10-16/offline-esbuild/`.
Copy the shared mirror to private scratch, merge the additional `index.json`
entries, and copy their `objects/` files there. Set `MATRIX_CACHE` to that private
copy. Do not overwrite the shared mirror or run the checks in recording mode.
The recording came from `https://registry.npmjs.org` on 2026-10-16; object names
are SHA-256 digests. The coordinator removes that evidence after review.
