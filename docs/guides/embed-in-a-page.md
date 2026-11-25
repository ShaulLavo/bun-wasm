# Embed bun-wasm in a page

Register Bun as a program on a [Waffle](https://github.com/ShaulLavo/waffle) `Runtime` that your page already owns. After this guide, `/bin/bun` and `/bin/node` resolve to bun-wasm for every process that Runtime spawns. This guide assumes you know Vite and the page owns the `Runtime`. [Browser package](../browser-package.md) is the full reference for exports, ownership and acceptance gates.

bun-wasm is not on npm. You install it as a Git dependency.

> **Early API.** The embedding API and Waffle's public API are still changing. The snippets follow the package tests. Recheck them when you update either pin.

## Install the package

Pin bun-wasm to an exact commit. Use that checkout's `waffle` development pin
for the app's runtime.

```json
{
	"dependencies": {
		"bun-wasm": "github:ShaulLavo/bun-wasm#<commit>",
		"waffle": "npm:@waffle-os/runtime@0.0.148"
	},
	"trustedDependencies": ["bun-wasm"]
}
```

Run `bun install`. The bun-wasm Git dependency generates its Node entry points
during `prepare`. The npm runtime ships its Node entry points. The guest
downloads at run time.

## Build and host the guest

No guest is published for the current source, so the package has no default
(`BUN_WASM_ASSET` is `null`). Build the browser guest from the same bun-wasm
commit you pinned, then serve `dist/bun-browser.wasm` (or a gzip copy) from
your own host:

```sh
source env.sh
scripts/sync-bun.sh
scripts/build-bun-browser.sh
sha256sum dist/bun-browser.wasm && stat -c %s dist/bun-browser.wasm
```

The hash and byte count go into the `asset` descriptor below. They cover the
uncompressed file.

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

const asset = { kind: "single", core: { url: "/bun-browser.wasm", sha256: "<sha256>", bytes: 0 /* uncompressed size */ } } as const;
const installation = await installBunAdapters(runtime, { workerUrl: bunWorkerUrl, notificationWorkerUrl, asset });

// Later, to unregister Bun. Running processes continue.
installation.dispose();
```

`installBunAdapters` never creates or disposes the `Runtime`. It registers the Bun launchers, registers the programs, and writes a small marker file at each executable path. `/bin/bun` and `/bin/node` are the default paths for the `browser` engine. Pass `executables: ["/opt/bun/browser"]` to use other absolute paths, or `executables: []` to register none.

The guest downloads on the first spawn, not during installation. Without `asset` or `module`, that spawn fails with `BunWasmAssetError: No matching Bun guest has been published; provide asset or module`.

How you start a process depends on the Waffle host. A Waffle shell such as bash-web spawns `/bin/bun` like any other command. Waffle's `startCommand` from `waffle/command` does not run Bun yet: it admits only interruptible byte-backed guests, and Bun registers as a cooperative adapter program, so the spawn exits with `EACCES`. The playground starts runs itself with `startRun` in `web/src/runner.ts`. That function is not part of the package exports.

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
	asset: {
		kind: "quickjs",
		core: { url: "/bun.wasm", sha256: "<sha256>", bytes: 0 /* uncompressed size */ },
		side: { url: "/quickjs.wasm", sha256: "<sha256>", bytes: 0 },
	},
});
```

The QuickJS and JSC executables register under `/opt/bun/quickjs/bin` and `/opt/bun/jsc/bin`. Never use the browser descriptor for them.

## Control where the guest comes from

`loadBunWasm({ asset, wasmUrl, module, fetch })` downloads the guest and checks its decompressed byte count and SHA-256 before compiling. A mismatch rejects with `BunWasmAssetError`:

```
BunWasmAssetError: Guest SHA-256 mismatch: expected 0000…0000, received e63f4b4f…cb6d2f3
```

- Pass `asset` to download a guest you host. This is the normal path, because `BUN_WASM_ASSET` is `null` until a matching guest is published again.
- Pass `wasmUrl` with `asset` to fetch the same bytes from another URL. The integrity values still apply.
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
