# Embed bun-wasm in a page

Register Bun as a program on a [Waffle](https://github.com/ShaulLavo/waffle) `Runtime` that your page already owns. After this guide, `/bin/bun` and `/bin/node` resolve to bun-wasm for every process that Runtime spawns. This guide assumes you know Vite and the page owns the `Runtime`. [Browser package](../browser-package.md) is the full reference for exports, ownership and acceptance gates.

bun-wasm is not on npm. You install it as a Git dependency.

> **Early API.** The embedding API and Waffle's public API are still changing, and not every path works yet. The snippets below follow the package's code and its package tests, but this guide has not been run as a complete page, so expect to adjust them. Pin exact commits and re-check this guide when you update either one.

## Install the package

Pin both repositories to exact commits. The Waffle commit must be the one in bun-wasm's own `peerDependencies`. At this revision that is `c1cb67c300439af24335d0b2ec481bfb52f79a01`.

```json
{
	"dependencies": {
		"bun-wasm": "github:ShaulLavo/bun-wasm#<commit>",
		"waffle": "github:ShaulLavo/waffle#c1cb67c300439af24335d0b2ec481bfb52f79a01"
	},
	"trustedDependencies": ["bun-wasm", "waffle"]
}
```

Run `bun install`. Both packages generate their Node entry points in a Bun-only `prepare` script, which is why both must be in `trustedDependencies`. The package ships no `.wasm` file. The guest downloads at run time.

## Bundle the worker

The package exports `bun-wasm/worker`, a module-worker entry. Bundle it as a worker and never import it into the page. In Vite, set the worker format to ES modules:

```ts
// vite.config.ts
export default { worker: { format: "es" } };
```

Add `/// <reference types="vite/client" />` to your environment declarations for the `?worker&url` import.

## Install Bun on the Runtime

```ts
import { createRuntime } from "waffle";
import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";
import notificationWorkerUrl from "bun-wasm/notification-worker?worker&url";

// Skip createRuntime if your page already created the Runtime.
const runtime = createRuntime({ filesystem: { workerURL: "/fs-worker.js", mode: "memory" } });

const installation = await installBunAdapters(runtime, { workerUrl: bunWorkerUrl, notificationWorkerUrl });

// Later, to unregister Bun. Running processes continue.
installation.dispose();
```

`installBunAdapters` never creates or disposes the `Runtime`. It registers the Bun launchers, registers the programs, and writes a small marker file at each executable path. `/bin/bun` and `/bin/node` are the default paths for the `browser` engine. Pass `executables: ["/opt/bun/browser"]` to use other absolute paths, or `executables: []` to register none.

How you start a process depends on the Waffle host. A Waffle shell such as bash-web spawns `/bin/bun` like any other command. The playground starts runs itself with `startRun` in `web/src/runner.ts`. That function is not part of the package exports.

## Serve the page

Send these headers. Waffle needs them for shared process state, and the Bun network bridge needs them for servers and `fetch`.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Choose an engine

`engine` defaults to `"browser"`, which runs your code on the page's own JavaScript engine. `"quickjs"` and `"jsc"` need their matching guest, and `installBunAdapters` throws a `TypeError` without one:

```ts
await installBunAdapters(runtime, {
	workerUrl: bunWorkerUrl,
	notificationWorkerUrl,
	engine: "quickjs",
	asset: { url: "https://example.com/<sha256>/bun.wasm", sha256: "<sha256>", bytes: 0 /* decompressed size */ },
});
```

The QuickJS and JSC executables register under `/opt/bun/quickjs/bin` and `/opt/bun/jsc/bin`. Never use the browser descriptor for them.

## Control where the guest comes from

`loadBunWasm({ asset, wasmUrl, module, fetch })` downloads the guest and checks its decompressed byte count and SHA-256 before compiling. A mismatch rejects with `BunWasmAssetError`:

```
BunWasmAssetError: Guest SHA-256 mismatch: expected 0000…0000, received e63f4b4f…cb6d2f3
```

- Omit every option to use `BUN_WASM_ASSET`, the published browser guest.
- Pass `wasmUrl` to serve the same guest from your own host. The integrity values still apply.
- Pass `module`, a compiled `WebAssembly.Module`, to skip the network. Use it for offline pages and tests.

A guest must come from the same source revision as the host package. Do not substitute a mutable URL. [Guest artifact publishing](../guest-publishing.md) covers building and publishing your own.

## If it fails

If `installBunAdapters` rejects, find the error in [Troubleshooting](../troubleshooting.md#installbunadapters-rejects). To check the package itself, run its tests in a bun-wasm checkout:

```sh
source env.sh
bun install
bun run check
bun test ./tests/package/*.test.ts
```
