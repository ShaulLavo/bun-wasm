// Builds the playground into web/dist as plain static files.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
// (Not BUN_JSC_WASM: Bun refuses to start when a BUN_JSC_* variable is not a JSC option.)
import { existsSync, rmSync, statSync } from "node:fs";
import { previewWebsocketScript } from "./preview-build";
import { buildBrowserEntries, buildClassicWorker } from "../scripts/browser-build";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const out = join(here, "dist");
const wasmSource = resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm");

rmSync(out, { recursive: true, force: true });

// Main and worker share chunks; the helper also mirrors chunks into the worker's scope.
const result = await buildBrowserEntries([join(here, "src/main.ts"), join(here, "src/worker.ts"), join(here, "src/fs-worker.ts")], out, { runtimeWorker: true });

// The service worker is a classic script (module service workers are newer in Safari).
const sw = await buildClassicWorker(join(here, "src/sw.ts"), out, {
  __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(await previewWebsocketScript()),
});

await Bun.write(join(out, "index.html"), Bun.file(join(here, "index.html")));
// Cloudflare Static Assets headers: cross-origin isolation (SharedArrayBuffer for
// Atomics.wait sleeps and the networking bridge). serve.ts sends the same locally.
await Bun.write(join(out, "_headers"), Bun.file(join(here, "_headers")));

// Each wasm gets a .gz twin; serve.ts sends that when the browser accepts gzip.
const engineBuilds: Record<string, string> = {};

async function copyWasm(source: string, name: string): Promise<boolean> {
  if (!existsSync(source)) return false;
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  engineBuilds[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  // Only the .gz ships: the page decompresses it, and static hosts cap file sizes
  // (Cloudflare: 25 MiB; bun-jsc.wasm is 43 MB raw, 12 MB gzipped).
  await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(bytes, { level: 9 }));
  console.log(`${name}: copied ${source} (${(statSync(source).size / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}
if (!(await copyWasm(wasmSource, "bun.wasm"))) {
  console.warn(`bun.wasm: ${wasmSource} not found; the site will say bun.wasm is missing (or pass ?wasm=<url>).`);
}
const jscSource = resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm");
if (!(await copyWasm(jscSource, "bun-jsc.wasm"))) {
  console.warn(`bun-jsc.wasm: ${jscSource} not found; the JavaScriptCore engine option will fail to load.`);
}
const browserSource = resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm");
if (!(await copyWasm(browserSource, "bun-browser.wasm"))) {
  console.warn(`bun-browser.wasm: ${browserSource} not found; the Browser (native) engine option will fail to load.`);
}

await Bun.write(join(out, "engine-builds.json"), JSON.stringify(engineBuilds));
const index = await Bun.file(join(here, "index.html")).text();
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>globalThis.__bunwasmBuilds=${JSON.stringify(engineBuilds)}</script>`));

for (const output of result.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
