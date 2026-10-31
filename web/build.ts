// Builds the playground into web/dist as plain static files.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
// BUN_TOOLS_WASM overrides ../dist/bun-tools.wasm; HERMES_WASM overrides the opt-in ../dist/bun-hermes.wasm.
// bash-web guests come from scripts/build-bash-web-shell.sh (BASH_WEB_GUESTS_DIR overrides ../dist).
// (Not BUN_JSC_WASM: Bun refuses to start when a BUN_JSC_* variable is not a JSC option.)
import { existsSync, rmSync, statSync } from "node:fs";
import { previewWebsocketScript } from "./preview-build";
import { buildBrowserEntries, buildClassicWorker, buildShellAssets } from "../scripts/browser-build";
import { dirname, join, resolve } from "node:path";

const here = import.meta.dir;
const out = join(here, "dist");
const wasmSource = resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm");

rmSync(out, { recursive: true, force: true });

// Bundle each browser realm independently and mirror worker chunks into its scope.
const result = await buildBrowserEntries([join(here, "src/main.ts"), join(here, "src/worker.ts"), join(here, "src/fs-worker.ts"), join(here, "src/notification-worker.ts")], out, { runtimeWorker: true });

// The service worker is a classic script (module service workers are newer in Safari).
const sw = await buildClassicWorker(join(here, "src/sw.ts"), out, {
  __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(await previewWebsocketScript()),
}, join(here, "src/main.ts"));

await Bun.write(join(out, "index.html"), Bun.file(join(here, "index.html")));
// Cloudflare Static Assets headers: cross-origin isolation (SharedArrayBuffer for
// Atomics.wait sleeps and the networking bridge). serve.ts sends the same locally.
await Bun.write(join(out, "_headers"), Bun.file(join(here, "_headers")));

type Metafile = NonNullable<typeof result.metafile>;

/** Hashed chunks reachable through the imports of `roots`, as paths relative to dist. */
function reachableChunks(metafile: Metafile, roots: string[]): string[] {
  const chunks = new Set<string>();
  const pending = roots.slice();
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    for (const imported of metafile.outputs[path]?.imports ?? []) {
      const dependency = imported.path in metafile.outputs ? imported.path : `./${join(dirname(path), imported.path)}`;
      if (!dependency.startsWith("./chunks/") || !dependency.endsWith(".js") || chunks.has(dependency)) continue;
      chunks.add(dependency);
      pending.push(dependency);
    }
  }
  return Array.from(chunks, chunk => chunk.slice(2)).sort();
}

/**
 * The chunks a first command loads: the page's lazy command code (main.js imports the runner and
 * Waffle's process and network services on demand) and everything the Bun worker imports. The
 * page fetches them while idle so the command finds them in the HTTP cache.
 */
function commandChunks(metafile: Metafile): string[] {
  const lazy = (metafile.outputs["./main.js"]?.imports ?? []).filter(imported => imported.kind === "dynamic-import").map(imported => imported.path);
  return Array.from(new Set(reachableChunks(metafile, ["./worker.js"]).concat(lazy.map(path => path.slice(2)), reachableChunks(metafile, lazy)))).sort();
}

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
const quickjsSource = join(dirname(wasmSource), "quickjs.wasm");
if (existsSync(wasmSource) && !(await copyWasm(quickjsSource, "quickjs.wasm"))) {
  throw new Error(`QuickJS core requires its matching side module: ${quickjsSource}`);
}
const jscSource = resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm");
if (!(await copyWasm(jscSource, "bun-jsc.wasm"))) {
  console.warn(`bun-jsc.wasm: ${jscSource} not found; the JavaScriptCore engine option will fail to load.`);
}
const jscEngineSource = join(dirname(jscSource), "jsc-engine.wasm");
if (existsSync(jscSource) && !(await copyWasm(jscEngineSource, "jsc-engine.wasm"))) {
  throw new Error(`JSC core requires its matching side module: ${jscEngineSource}`);
}
const browserSource = resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm");
if (!(await copyWasm(browserSource, "bun-browser.wasm"))) {
  console.warn(`bun-browser.wasm: ${browserSource} not found; the Browser (native) engine option will fail to load.`);
}

const hermesSource = resolve(here, process.env.HERMES_WASM ?? "../dist/bun-hermes.wasm");
await copyWasm(hermesSource, "bun-hermes.wasm");
const hermesEngineSource = join(dirname(hermesSource), "hermes-engine.wasm");
if (existsSync(hermesSource) && !(await copyWasm(hermesEngineSource, "hermes-engine.wasm"))) {
  throw new Error(`Hermes core requires its matching side module: ${hermesEngineSource}`);
}

const toolsSource = resolve(here, process.env.BUN_TOOLS_WASM ?? "../dist/bun-tools.wasm");
if (!(await copyWasm(toolsSource, "bun-tools.wasm"))) {
  console.warn(`bun-tools.wasm: ${toolsSource} not found; lint and fmt will not be available.`);
}

await buildShellAssets(here, out);

await Bun.write(join(out, "engine-builds.json"), JSON.stringify(engineBuilds));
const index = await Bun.file(join(here, "index.html")).text();
const startup = `globalThis.__bunwasmBuilds=${JSON.stringify(engineBuilds)};globalThis.__bunwasmCommandChunks=${JSON.stringify(commandChunks(result.metafile!))}`;
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>${startup}</script>`));

for (const output of result.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
