// Builds the playground into web/dist as plain static files.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
// BUN_TOOLS_WASM overrides ../dist/bun-tools.wasm.
// bash-web guests come from scripts/build-bash-web-shell.sh (BASH_WEB_GUESTS_DIR overrides ../dist).
// (Not BUN_JSC_WASM: Bun refuses to start when a BUN_JSC_* variable is not a JSC option.)
import { existsSync, rmSync, statSync } from "node:fs";
import { templateFiles } from "../sandbox/template-files";
import { projectTemplates } from "./src/playground/project-templates";
import { previewWebsocketScript } from "./preview-build";
import { buildBrowserEntries, buildClassicWorker, buildShellAssets, publishVersionedEntries, rewriteEntryHtml, VERSIONED_WORKER_FILES } from "../scripts/browser-build";
import { dirname, join, resolve } from "node:path";
import { stageSharedPrograms } from "../scripts/stage-program-profiles";
import { brotliQuality, sortedBuilds, stageGuestWasm } from "../scripts/stage-guest-wasm";
import { appOutput } from "../scripts/app-output";
import { settleAll } from "../scripts/stage-wasm-sidecars";

const here = import.meta.dir;
// BUN_WASM_APP_OUT builds somewhere disposable instead of web/dist (tests, side-by-side builds).
const out = appOutput(here);
const wasmSource = resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm");

// An invalid setting fails before the previous build is removed.
brotliQuality();
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

// Each wasm ships as .br and .gz twins (scripts/stage-guest-wasm.ts). Every pair is checked before
// any guest stages; then they compress concurrently, since Brotli quality 11 for a site deploy
// takes tens of seconds per guest.
const engineBuilds: Record<string, string> = {};
const guests: { source: string; name: string }[] = [];

function copyWasm(source: string, name: string): boolean {
  if (!existsSync(source)) return false;
  guests.push({ source, name });
  return true;
}
if (!copyWasm(wasmSource, "bun.wasm")) {
  console.warn(`bun.wasm: ${wasmSource} not found; the site will say bun.wasm is missing (or pass ?wasm=<url>).`);
}
const quickjsSource = join(dirname(wasmSource), "quickjs.wasm");
if (existsSync(wasmSource) && !copyWasm(quickjsSource, "quickjs.wasm")) {
  throw new Error(`QuickJS core requires its matching side module: ${quickjsSource}`);
}
const jscSource = resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm");
if (!copyWasm(jscSource, "bun-jsc.wasm")) {
  console.warn(`bun-jsc.wasm: ${jscSource} not found; the JavaScriptCore engine option will fail to load.`);
}
const jscEngineSource = join(dirname(jscSource), "jsc-engine.wasm");
if (existsSync(jscSource) && !copyWasm(jscEngineSource, "jsc-engine.wasm")) {
  throw new Error(`JSC core requires its matching side module: ${jscEngineSource}`);
}
if (process.env.SPIDERMONKEY_WASM) {
  const source = resolve(here, process.env.SPIDERMONKEY_WASM);
  if (!copyWasm(source, "bun-spidermonkey.wasm")) throw new Error(`SpiderMonkey core is missing: ${source}`);
  const side = join(dirname(source), "spidermonkey-engine.wasm");
  if (!copyWasm(side, "spidermonkey-engine.wasm")) throw new Error(`SpiderMonkey core requires its matching side module: ${side}`);
}
const browserSource = resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm");
if (!copyWasm(browserSource, "bun-browser.wasm")) {
  console.warn(`bun-browser.wasm: ${browserSource} not found; the Browser (native) engine option will fail to load.`);
}

const toolsSource = resolve(here, process.env.BUN_TOOLS_WASM ?? "../dist/bun-tools.wasm");
if (!copyWasm(toolsSource, "bun-tools.wasm")) {
  console.warn(`bun-tools.wasm: ${toolsSource} not found; lint and fmt will not be available.`);
}
const staging = guests.map(async ({ source, name }) => {
  await stageGuestWasm(source, name, out, engineBuilds);
  console.log(`${name}: copied ${source} (${(statSync(source).size / 1024 / 1024).toFixed(1)} MB)`);
}).concat([stageSharedPrograms(out, engineBuilds), buildShellAssets(here, out)]);
// A failure is reported only after every writer settled, so none is still writing into dist.
await settleAll(staging);

const builds = sortedBuilds(engineBuilds);
for (const template of projectTemplates) {
  const files = await templateFiles(resolve(here, "../sandbox", template.directory));
  const bytes = new TextEncoder().encode(JSON.stringify({ files }));
  builds[template.file] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(out, template.file), bytes);
}
builds["sw.js"] = new Bun.CryptoHasher("sha256").update(await Bun.file(join(out, "sw.js")).bytes()).digest("hex");
const entries = await publishVersionedEntries(out);
const workerAssets = Object.fromEntries(VERSIONED_WORKER_FILES.map(name => [name, entries[name]!]));
await Bun.write(join(out, "engine-builds.json"), JSON.stringify(builds));
const index = rewriteEntryHtml(await Bun.file(join(here, "index.html")).text(), entries);
const startup = `globalThis.__bunwasmBuilds=${JSON.stringify(builds)};globalThis.__bunwasmAssets=${JSON.stringify(workerAssets)};globalThis.__bunwasmCommandChunks=${JSON.stringify(commandChunks(result.metafile!))}`;
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>${startup}</script>`));

for (const output of result.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
