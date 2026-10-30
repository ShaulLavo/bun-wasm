# Browser package (Git dependency)

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

Registered programs launch ordinary Waffle processes through the generic `runtime_proc` bridge.
Supply the bundler-produced worker URL. The default browser engine loads the published immutable
guest through `BUN_WASM_ASSET`, verifying its decompressed size and SHA-256 before compilation.
No module or asset override is needed for that default. QuickJS and JSC are explicit opt-ins and
require their matching compiled module or verified asset descriptor; the browser descriptor must
not be used for them. Guest bytes remain outside the package. No legacy Bun-specific process
controller is used.

```ts
import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";
import notificationWorkerUrl from "bun-wasm/notification-worker?worker&url";

// runtime is the same instance already owned by bash-web/the application.
const installation = await installBunAdapters(runtime, {
  workerUrl: bunWorkerUrl,
  notificationWorkerUrl, // one helper per Bun process; wakes fs.watch on filesystem commits
  engine: "browser", // default; quickjs/jsc need their matching guest module or descriptor
  // module: offlineCompiledModule,
  // wasmUrl: "https://your-immutable-store/<sha256>/bun.wasm.gz",
  // asset: { url, sha256, bytes },
});

// Registers bun:quickjs, bun:jsc, bun:browser and the selected engine at its real bun/node paths.
// Optional executables: ["/opt/bun/browser"] chooses other paths; [] leaves programs caller-owned.
// Ordinary Waffle spawn requests select these registered executable paths.

installation.dispose(); // idempotent; unregisters only this installation's adapters/programs
// Existing processes continue. A new spawn no longer resolves this installation's Bun command.
// Installing again on the same Runtime works. A second simultaneous installation is rejected.
```

Executable locations are defined by `src/executable-paths.ts`: browser uses `/bin/{bun,node}`,
QuickJS uses `/opt/bun/quickjs/bin/{bun,node}`, and JSC uses `/opt/bun/jsc/bin/{bun,node}`.
Each install defaults to the selected engine's two files; `executables` overrides them. The demo
registers all six files once and prepends its root engine's directory to inherited `PATH`.
Bun.spawn and Bun.which share live executable-access lookup: slash-containing names bypass PATH,
entries are searched in order, and an empty entry means cwd. Absolute paths always mean exactly
that registered program. A Preview1 root uses its supplied module directly, without an implicit
self executable; a recursive Preview1 program must register its own absolute file path.

The installer makes no process/root reservations and does not own preview1 adapters, filesystem
services, terminal streams, shell jobs, or the Runtime lifetime. Registration failures roll back
all registrations already made by that installation. Unrelated registrations are preserved.
Installation creates parent directories and a small executable marker at each registered absolute
path. A different existing file or directory rejects with `BunWasmExecutableConflictError`
(`BUN_WASM_EXECUTABLE_CONFLICT`) and is never overwritten. Markers are created atomically with
Waffle's exclusive-write option, so an external writer that wins after the initial checks keeps
its file or directory. A matching marker can be shared, including a concurrent winner; failed
installation rolls back only paths it successfully created, not those shared markers. Unrelated
storage errors remain errors. Disposal leaves markers in the caller-owned filesystem, so
reinstall works without deleting files that existing processes might use.
Callers that register extra programs with Waffle are responsible for their own unregister handles.

### Shared networking

The installer borrows networking from the caller's Runtime. Bun processes and their children
share its loopback namespace for HTTP and WebSocket previews, with a separate helper for each
process. Stopping one process releases its helper without closing another process's connections.
The installer's fetch policy applies to roots and children. Browser host `fetch` remains subject
to browser restrictions such as CORS. Preview1 programs do not receive Bun networking helpers.

To check a selected guest before browser acceptance, supply its absolute artifact path and an
independently accepted `GuestBuildInputs` JSON file from `scripts/guest-build-receipt.ts inputs`.
The gate requires the artifact's adjacent `.build.json` receipt and checks its source commit,
source tree, sysroot receipt digest, artifact SHA-256, and byte count before browser setup.
It never downloads a guest. The accepted input file uses the existing fields `bunHead`, `bunTree`,
and `sysrootReceiptSha256`. Do not derive those expectations from an unreviewed artifact sidecar.

```sh
NETWORK_CONSUMER_GUEST=/absolute/bun-browser.wasm \
NETWORK_CONSUMER_EXPECTED_INPUTS=/absolute/accepted-inputs.json \
NETWORK_CONSUMER_PREFLIGHT_ONLY=1 \
  bun web/tests/browser-network-consumer.ts chromium
```

Preflight prints the verified receipt but does not establish browser acceptance. After source
review and artifact selection, omit `NETWORK_CONSUMER_PREFLIGHT_ONLY` and set
`NETWORK_CONSUMER_PORT` to an explicit free port for the existing browser gate. It runs both
`prepare` and `publicAdapter` modes for each browser named on the command line.

### Real bash-web composition

The installer also supplies networking to Bun launched by an external shell. A shell-launched
Bun server and nested Bun processes use the page's existing network service, not a private network.

`bun run test:browser:shell-consumer` is configured to install a packed Bun package and
bash-web at `c92bd41da9ccc3fdc48b4d11a20288ce9969e2d5` with Waffle 0.0.90 at
`c1cb67c300439af24335d0b2ec481bfb52f79a01`. The selected shell still declares the previous
Waffle peer, so the exact-peer check currently rejects this combination. A separately reviewed
shell pin with the matching peer is required before this command can establish acceptance.
The command builds the installed shell's workers, runtime-backed shell guest and utility guests
explicitly. Git `prepare` alone does not build that shell guest.
The test imports `bun-wasm`, `bun-wasm/worker` and bash-web's public exports, not checkout workers
or a shell substitute. Rust, the `wasm32-wasip1` target, wasi-sdk 34 and cached Playwright 1.64.1
browsers are prerequisites. Source `env.sh` on this workstation and use its heavy-job queue.

```sh
SHELL_CONSUMER_GUEST=/absolute/accepted/bun-browser.wasm \
SHELL_CONSUMER_EXPECTED_INPUTS=/absolute/accepted-inputs.json \
SHELL_CONSUMER_PORT=43831 \
  bun run test:browser:shell-consumer
# Record WebKit separately with the same inputs:
# bun web/tests/browser-shell-consumer.ts webkit
```

The accepted inputs and `.build.json` checks are the same as the network gate above.
`SHELL_CONSUMER_PREFLIGHT_ONLY=1` checks them without building or opening a browser.
Each case reports its own outcome and later cases still run after failures; any failure keeps
the command red. Reports include package pins, worker paths, guest hashes, process ancestry,
fixed pipe allocation sizes, terminal queue peaks, actual service-worker preview delivery and
resource teardown. A separate live consumer must survive shell/adapter disposal until the page
owner disposes the runtime. WebKit is not real Safari acceptance.

This is a standalone artifact-backed command, not another step in the ten-minute artifact-free
CI browser job. Compiling an installed Rust shell and providing an accepted Bun guest do not fit
that job's existing budget. Its receipt preflight controls run in the ordinary unit suite.

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
for an installer URL. With other build tools, explicitly bundle the `bun-wasm/worker` and
`bun-wasm/notification-worker` exports and pass the emitted URLs as `workerUrl` and
`notificationWorkerUrl`; do not point at the repository's `web/dist` directory.

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
documented in [the publishing guide](guest-publishing.md). A guest must come from the matching host source
revision; do not substitute an old site's mutable `bun.wasm.gz` URL.

```sh
source env.sh
bun install
bun run check
bun test ./tests/package/*.test.ts
bun run build
```

To repeat the public default's real-process acceptance after rebuilding the matching browser guest,
explicitly opt into network downloads. The gate compares the build receipt with the descriptor and
checks that each real guest scenario fetches the public immutable URL, never the local artifact.
Its generic byte-fixture control stays artifact-free. The inherited-fd controls use a real
filesystem file: the external root consumes its prefix, the child reads the shared cursor at fd4,
and fd3 remains the inherited output descriptor. Browser profiles, listener and scratch bundles
are removed on exit.

```sh
BUN_WASM_RUNTIME_PROC_ARTIFACT="$PWD/dist/bun-browser.wasm" \
BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT=1 \
  bun web/tests/bun-runtime-proc-browser.ts chromium firefox webkit
```

### Required full-build interruption acceptance

The immutable guest publication command runs the real engine-interruption harness in
Chromium, Firefox and WebKit **before** contacting storage or changing a descriptor. Build
all three artifacts from the source revision being published: `dist/bun.wasm`,
`dist/bun-jsc.wasm` and `dist/bun-browser.wasm`. The upload (raw or gzip) must match one
of those exact artifacts; missing builds, failed proofs or unsafe cleanup stop publication.
Use `--dist /absolute/full-build-directory` when the matching builds are elsewhere.
Install the [publishing dependencies and browser executables](guest-publishing.md#commands)
first. Publication serves a private read-only snapshot, checks every browser's actual
loaded hashes and byte counts, then uploads only the verified snapshot bytes.

```sh
source env.sh
export PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright
bun scripts/publish-guest.ts dist/bun-browser.wasm --output src/guest-asset.generated.ts
```

To run the same acceptance without publishing, use
`cd web && bun run test:browser:engine-interruption`. Set
`BUN_WASM_INTERRUPTION_DIST=/absolute/full-build-directory` to select matching builds.
The harness records per-browser outcomes, exact artifact hashes, native wait samples,
notify-removal negative controls and owned-resource cleanup in its JSON output.

GitHub's browser jobs intentionally use no Rust/dist builds. `scripts/test-web.sh` runs
this artifact-backed gate when all builds exist, or prints `SKIPPED` with every missing
file. Publication never skips it. Unit coverage checks admission/cleanup and a real
native worker regression, but cannot replace this three-browser full-build acceptance.
