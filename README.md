# Bun's toolchain in WebAssembly, with a Bun-compatible runtime

Bun's own Rust toolchain (transpiler, bundler, dev server graph, parsers, semver, glob), built for
`wasm32-wasip1`, plus a runtime of our own that implements Bun's and Node's APIs on top of it. It
runs in the browser and in a native Wasmtime launcher. The runtime uses
[Bun's generated JavaScript builtins](docs/bun-builtins.md) where they run independently of JavaScriptCore. Rust natives and the remaining JavaScript API implementations
fill the gaps. We measure compatibility against [Bun's own test suite](docs/bun-test-suite/README.md).
[Runtime TypeScript](docs/runtime-typescript.md) describes the factory build and typecheck gate.

- `bun run`, `bun test`, `bun build`, `Bun.build`, `bun:sqlite`, `fetch`, `Bun.serve`
- Bun's real transpiler and bundler
- npm installer and command adapters: `bun install`, `bun add`, `bun remove`, `bun update`, `bun x`, and `bun pm ls` ([host requirements and browser bin execution](docs/install.md))
- In the browser: a playground ([web/](web/README.md)) and a React sandbox with hot reload ([sandbox/](sandbox/README.md))
- JS engine: QuickJS or Bun's JavaScriptCore compiled to wasm, or the browser's own engine ([docs/engine-browser.md](docs/engine-browser.md))

```sh
source env.sh && scripts/sync-bun.sh
scripts/build.sh                      # dist/bun.wasm
cargo build -j 4 --release -p bunwasm-host
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$PWD/dist/bun.wasm" \
  --dir "$PWD::/" --env PWD=/ -- run /index.ts
```

The native launcher supplies the guest's `runtime_proc` process imports; plain
`wasmtime run dist/bun.wasm` cannot instantiate this runtime.

[Changes to Bun and vendored dependencies](docs/bun-patches.md) lists each patch and distinguishes port work, host features, and upstream bugs.

## Browser package (Git dependency)

The repository root is the `bun-wasm` package. It borrows an existing [Waffle](https://github.com/ShaulLavo/waffle)
Runtime; it never creates or disposes the page's Runtime. Install **the same pinned Waffle revision**
in the application and keep both Git dependencies in Bun's `trustedDependencies` so their Bun-only
`prepare` scripts can generate the Node-conditioned output. Browser and Bun exports use TypeScript
source; Node uses the generated `dist/package/` entrypoints. No guest `.wasm` file is included in the package.

Exports are explicit:

- `bun-wasm`: adapter installation, engine types, verified guest loader, and asset metadata.
- `bun-wasm/worker`: module-worker entry; bundle it as a worker, never import it into the page.
- `bun-wasm/asset`: guest metadata and the verified loader without any worker or demo code.

### Installation and ownership

The adapter uses Waffle's generic process bridge. Invoking a registered Bun adapter delegates to
`service.launchWorker` with the side-effect-free `createBunExecutor` worker entry; it does not use
the legacy controller-backed subprocess path. The default asset descriptor is `null` until the
matching process-bridge guest is built and published; callers can supply a descriptor or a compiled
module. The installer contract is unchanged by the process bridge.

```ts
import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";

// runtime is the same instance already owned by bash-web/the application.
const installation = installBunAdapters(runtime, {
  workerUrl: bunWorkerUrl,
  engine: "browser", // default; quickjs/jsc need their matching guest module or descriptor
  // module: offlineCompiledModule,
  // wasmUrl: "https://your-immutable-store/<sha256>/bun.wasm.gz",
  // asset: { url, sha256, bytes },
});

// Registers bun:quickjs, bun:jsc, bun:browser and the selected engine's bun + /bin/bun aliases.
// Optional executables: ["bun-browser"] chooses other names; [] leaves aliases caller-owned.
// Ordinary Waffle spawn requests select these registered executable names.

installation.dispose(); // idempotent; unregisters only this installation's adapters/programs
// Existing processes continue. A new spawn no longer resolves this installation's Bun command.
// Installing again on the same Runtime works. A second simultaneous installation is rejected.
```

The installer makes no process/root reservations and does not own preview1 adapters, filesystem
services, terminal streams, shell jobs, or the Runtime lifetime. Registration failures roll back
all registrations already made by that installation. Unrelated registrations are preserved.
Callers that register extra programs with Waffle are responsible for their own unregister handles.

### Current networking limitations

Processes launched by this installer do not receive networking slots or share the playground's
networking ring. QuickJS and JSC processes therefore have no networking support through these
launchers. The browser engine retains direct host `fetch`, subject to browser restrictions such
as CORS; it does not gain a shared socket namespace. Sharing networking between processes is
tracked in [browser runtime plan, row 6](plans/browser-runtime.md#build-plan).

### Browser-engine import cycles

With `engine: "browser"`, the public Vite worker supports acyclic ESM imports only. Circular ESM
imports fail with `ERR_CIRCULAR_IMPORT`: the bundled `/assets/worker-entry-<hash>.js` worker does not
have a named module store. Cycles need a named module store and service-worker control. The site's
scoped `/__bunwasm/worker.js` path retains that support; the public package does not install it.
This restriction does not apply to QuickJS/JSC module loading. See [browser-engine module serving](docs/engine-browser.md#es-modules-native-with-live-bindings).

### Worker bundling

The example above is the tested Vite pattern. Vite must emit ES module workers:

```ts
export default { worker: { format: "es" } };
```

Add `/// <reference types="vite/client" />` to the application's environment declarations for
`?worker&url` typing. `tests/package/fixtures/vite-main.ts` builds through public exports in the
package test suite and checks that both the worker and page exclude a second Runtime owner.

Bundlers that resolve package specifiers inside worker URL constructors can instead use:

```ts
const worker = new Worker(new URL("bun-wasm/worker", import.meta.url), { type: "module" });
```

That form is a **bundler input**, not a native-browser bare URL. If the bundler does not transform
it, it requests a path literally named `bun-wasm/worker` and will fail. Prefer Vite's `?worker&url`
for an installer URL. With other build tools, explicitly bundle the `bun-wasm/worker` export and
pass the emitted URL as `workerUrl`; do not point at the repository's `web/dist` directory.

Serve the application with cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`) so Waffle can use shared process state.

### Guest integrity and offline use

`loadBunWasm({ asset, wasmUrl?, module?, fetch? })` verifies **decompressed** byte count and SHA-256
before compiling. It accepts raw Wasm, gzip bodies, and transparently HTTP-decoded responses.
The loader snapshots integrity metadata at call time and stops streaming once the decompressed
body exceeds the declared size, or the compressed body exceeds that size plus a 64 KiB allowance.
A URL override still uses the selected descriptor's integrity values; it does not disable checking.
A compiled `module` bypasses network access for tests and offline applications. The **asset loader**
requires no site-relative URL, local checkout path, localStorage, service worker, or demo cache.
This does not remove the browser engine's separate module-serving requirement for cyclic imports.

Immutable guests live outside static-site deployments. Publication and descriptor generation are
documented in [site/README.md](site/README.md). A guest must come from the matching host source
revision; do not substitute an old site's mutable `bun.wasm.gz` URL.

```sh
source env.sh
bun install
bun run check
bun test ./tests/package/*.test.ts
bun run build
```
