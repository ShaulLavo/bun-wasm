# Bun's toolchain in WebAssembly, with a Bun-compatible runtime

Bun's own Rust toolchain (transpiler, bundler, dev server graph, parsers, semver, glob), built for
`wasm32-wasip1`, plus a runtime of our own that implements Bun's and Node's APIs on top of it. It
runs in the browser and under wasmtime. The runtime uses
[Bun's generated JavaScript builtins](bun-builtins.md) where they run independently of JavaScriptCore. Rust natives and the remaining JavaScript API implementations
fill the gaps. We measure compatibility against [Bun's own test suite](bun-test-suite/guide.md).
[Runtime TypeScript](runtime-typescript.md) describes the factory build and typecheck gate.

- `bun run`, `bun test`, `bun build`, `Bun.build`, `bun:sqlite`, `fetch`, `Bun.serve`
- Bun's real transpiler, bundler, native lint rules, and formatter
- npm installer and command adapters: `bun install`, `bun add`, `bun remove`, `bun update`, `bun x`, and `bun pm ls` ([host requirements and browser bin execution](install.md))
- In the browser: a playground ([web/](browser-host.md)) and a React sandbox with hot reload ([sandbox/](sandbox.md))
- JS engine: QuickJS or Bun's JavaScriptCore compiled to wasm, or the browser's own engine ([docs/engine-browser.md](engine-browser.md))

```sh
source env.sh && scripts/sync-bun.sh
scripts/build.sh                      # dist/bun.wasm
wasmtime run --dir .::/ dist/bun.wasm run /index.ts
```

[Changes to Bun and vendored dependencies](bun-patches.md) lists each patch and distinguishes port work, host features, and upstream bugs.

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

**Current boundary:** this packaging change does not yet include the generic process bridge
(step 7b). Invoking a registered Bun adapter throws `BunWasmProcessUnavailableError`, with code
`BUN_WASM_PROCESS_UNAVAILABLE`. It does not silently use the old Bun controller path. The default
asset descriptor is `null` until the matching process-bridge guest is built and published; callers
can supply a descriptor or a compiled module. The 7b change completes execution without changing
the installation contract.

```ts
import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";

// runtime is the same instance already owned by bash-web/the application.
const installation = await installBunAdapters(runtime, {
  workerUrl: bunWorkerUrl,
  engine: "browser", // default; quickjs/jsc need their matching guest module or descriptor
  // module: offlineCompiledModule,
  // wasmUrl: "https://your-immutable-store/<sha256>/bun.wasm.gz",
  // asset: { url, sha256, bytes },
});

// Registers bun:quickjs, bun:jsc, bun:browser and the selected engine at /bin/bun.
// Optional executables: ["/opt/bun/browser"] chooses other paths; [] leaves programs caller-owned.
// With the default browser engine, await installBunAdapters(runtime) needs no options.
// After step 7b, ordinary Waffle spawn requests select these registered executable names.

installation.dispose(); // idempotent; unregisters only this installation's adapters/programs
// Existing processes continue. A new spawn no longer resolves this installation's Bun command.
// Installing again on the same Runtime works. A second simultaneous installation is rejected.
```

The installer makes no process/root reservations and does not own preview1 adapters, filesystem
services, terminal streams, shell jobs, or the Runtime lifetime. Registration failures roll back
all registrations already made by that installation. Unrelated registrations are preserved.
Installation creates parent directories and a small executable marker at each registered absolute
path. A different existing file or directory rejects with `BunWasmExecutableConflictError`
(`BUN_WASM_EXECUTABLE_CONFLICT`) and is never deliberately replaced. Matching markers can be
reused; disposal leaves them in the caller-owned filesystem, so reinstall works without deleting
files that existing processes might use. File checks and writes are not atomic against concurrent
external writers because Waffle's host filesystem API does not yet offer exclusive creation.
Callers that register extra programs with Waffle are responsible for their own unregister handles.

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
A compiled `module` bypasses network access for tests and offline applications. No site-relative
URL, local checkout path, localStorage, service worker, or demo cache is required by this API.

Immutable guests live outside static-site deployments. Publication and descriptor generation are
documented in [site/README.md](site.md). A guest must come from the matching host source
revision; do not substitute an old site's mutable `bun.wasm.gz` URL.

```sh
source env.sh
bun install
bun run check
bun test ./tests/package/*.test.ts
bun run build
```
