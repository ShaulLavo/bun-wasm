# Embed bun-wasm in a page

Register Bun as a program on a [Waffle](https://github.com/ShaulLavo/waffle) `Runtime` that your page owns. Once installed, `/bin/bun`, `/bin/node` and `/bin/nodejs` resolve to bun-wasm for every process that Runtime spawns. This guide assumes you use Vite and that your page owns the `Runtime`. See [Browser package](../browser-package.md) for the full export, ownership and acceptance reference.

bun-wasm is not on npm. Install it as a Git dependency.

> **Early API.** The embedding API and Waffle's public API still change. The snippets below match the package tests at this revision; recheck them when you move either pin.

## Install the package

Pin bun-wasm to an exact commit and match that checkout's `waffle` pin:

```json
{
	"dependencies": {
		"bun-wasm": "github:ShaulLavo/bun-wasm#<commit>",
		"waffle": "npm:@waffle-os/runtime@0.0.150"
	},
	"trustedDependencies": ["bun-wasm"]
}
```

Run `bun install`. The bun-wasm Git dependency generates its Node entry points during `prepare`, and the npm Waffle runtime ships its own. The default `browser` guest downloads at run time from the verified descriptor in `BUN_WASM_ASSET`. Until that descriptor is republished, it serves a pre-1.4.5 build from commit `7b25271e`, published in PR 1073. Build from source below if you need Bun 1.4.5.

## Bundle the workers

The package exports two module-worker entries: `bun-wasm/worker` and `bun-wasm/notification-worker`. Waffle exports its filesystem worker at `waffle/browser/fs-worker`. Bundle all three as workers and never import them directly into the page. In Vite, set the worker output format to ES modules:

```ts
// vite.config.ts
export default { worker: { format: "es" } };
```

Add `/// <reference types="vite/client" />` to your environment declarations so TypeScript recognizes `?worker&url`. If you bundle without Vite, for instance with `bun build`, create a one-line `fs-worker.ts` containing `import "waffle/browser/fs-worker";` and pass its built URL to `filesystem.workerURL`.

## Install Bun on the Runtime

```ts
import { createRuntime } from "waffle";
import fsWorkerUrl from "waffle/browser/fs-worker?worker&url";
import { installBunAdapters } from "bun-wasm";
import bunWorkerUrl from "bun-wasm/worker?worker&url";
import notificationWorkerUrl from "bun-wasm/notification-worker?worker&url";

// Skip createRuntime and fsWorkerUrl if your page already owns a Runtime.
const runtime = createRuntime({ filesystem: { workerURL: fsWorkerUrl, mode: "memory" } });

const installation = await installBunAdapters(runtime, {
	workerUrl: bunWorkerUrl,
	notificationWorkerUrl,
});

// Later, to unregister Bun. Running processes keep running.
installation.dispose();
```

`installBunAdapters` never creates or disposes the `Runtime`. It registers the Bun adapters and programs, then writes a small marker file at each executable path. For the default `browser` engine, those paths are `/bin/bun`, `/bin/node` and `/bin/nodejs`. Pass `executables: ["/opt/bun/browser"]` to pick other absolute paths, or `executables: []` to register none.

`bun lint`, `bun fmt` and `bun check` run in a separate module, `bun-tools.wasm`. Pass `loadTools: () => WebAssembly.compileStreaming(fetch(toolsUrl))` to enable them; it is called once, on the first such command. Without it those commands exit 1.

The default `browser` guest downloads on the first spawn, not during installation, using `BUN_WASM_ASSET` and verifying its uncompressed byte count and SHA-256 before compiling. You do not need to pass `asset` or `module` for the default `browser` engine.

How you launch a process depends on your Waffle host. A Waffle shell such as bash-web spawns `/bin/bun` like any other command. Waffle's `startCommand` from `waffle/command` does not run Bun yet. It admits only interruptible byte-backed guests, while Bun registers as a cooperative adapter program, so `startCommand` exits with `EACCES`. The playground launches runs through `startRun` in `web/src/runner.ts`, which is not part of the package exports.

## Serve the page

Send these headers on your page response. Waffle needs cross-origin isolation for shared process state, and the Bun network bridge needs it for servers and `fetch`.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Choose an engine

`engine` defaults to `"browser"`, which runs user code on the worker's own JavaScript engine. `"quickjs"`, `"jsc"` and the experimental opt-in `"spidermonkey"` engine each require their matching paired guest with `core` and `side` files. `installBunAdapters` throws a `TypeError` without `asset` or `module`:

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

By default, QuickJS registers under `/opt/bun/quickjs/bin`, JSC under `/opt/bun/jsc/bin`, and SpiderMonkey under `/opt/bun/spidermonkey/bin`. Never pass the `browser` descriptor to an in-Wasm engine.

## Control where the guest comes from

`loadBunWasm({ asset, wasmUrl, module, fetch })` downloads the guest and checks its uncompressed byte count and SHA-256 before compiling. Calling `loadBunWasm()` with no options loads the published default browser guest from `BUN_WASM_ASSET`. A mismatch rejects with `BunWasmAssetError`:

```
BunWasmAssetError: Guest SHA-256 mismatch: expected 0000...0000, received e63f4b4f...cb6d2f3
```

- Omit `asset`, `wasmUrl` and `module` to download the published default `browser` guest from `BUN_WASM_ASSET`.
- Pass `wasmUrl` to serve that same published guest from your own host while keeping the integrity checks in `BUN_WASM_ASSET`, or pass `wasmUrl` with `asset` to override your descriptor's core URL.
- Pass `asset` to download a guest you built and host yourself.
- Pass `module`, a compiled `WebAssembly.Module`, to skip the network in tests or offline pages.

To build and self-host the `browser` guest from the same bun-wasm commit you pinned, run:

```sh
source env.sh
scripts/sync-bun.sh
scripts/build-bun-browser.sh
sha256sum dist/bun-browser.wasm && stat -c %s dist/bun-browser.wasm
```

Serve `dist/bun-browser.wasm`, or a gzip copy of it, and put that hash and uncompressed byte count into `asset`:

```ts
const asset = {
	kind: "single",
	core: { url: "/bun-browser.wasm", sha256: "<sha256>", bytes: 0 /* uncompressed size */ },
} as const;
```

Build self-hosted guests from the same source commit as the host package and avoid mutable URLs. [Guest artifact publishing](../guest-publishing.md) covers building and publishing your own artifacts.

## If it fails

If `installBunAdapters` rejects, look up the error in [Troubleshooting](../troubleshooting.md#installbunadapters-rejects). To verify the package itself inside a bun-wasm checkout:

```sh
source env.sh
bun install
bun run check
bun test ./tests/package/*.test.ts
```
