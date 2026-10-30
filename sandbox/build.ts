// Builds the sandbox into sandbox/dist as plain static files: the page, the shared bun worker and
// service worker from web/src, each engine's wasm (gzipped), and the React and vanilla template sources.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
// BUN_TOOLS_WASM overrides ../dist/bun-tools.wasm; BASH_WEB_GUESTS_DIR overrides ../dist for bash-web guests (scripts/build-bash-web-shell.sh).
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { previewWebsocketScript } from "../web/preview-build";
import { buildBrowserEntries, buildClassicWorker, buildShellAssets } from "../scripts/browser-build";
import { dirname, join, relative, resolve } from "node:path";
import { templates } from "./src/template-catalog";

const here = import.meta.dir;
const web = resolve(here, "../web");
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });

// Bundle each browser realm independently and mirror worker chunks into its scope.
const page = await buildBrowserEntries([join(here, "src/main.ts"), join(web, "src/worker.ts"), join(web, "src/fs-worker.ts"), join(web, "src/notification-worker.ts")], out, { runtimeWorker: true });
// The service worker stays standalone and classic for Safari.
const sw = await buildClassicWorker(join(web, "src/sw.ts"), out, {
  __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(await previewWebsocketScript()),
}, join(here, "src/main.ts"));

await Bun.write(join(out, "index.html"), Bun.file(join(here, "index.html")));
await Bun.write(join(out, "_headers"), Bun.file(join(web, "_headers")));

// ---------- engines ----------

const engineBuilds: Record<string, string> = {};

async function copyWasm(source: string, name: string): Promise<boolean> {
  if (!existsSync(source)) {
    console.warn(`${name}: ${source} not found; that engine will say it is missing.`);
    return false;
  }
  // Only the .gz ships: the page decompresses it (hosts cap file sizes).
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  engineBuilds[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(bytes, { level: 9 }));
  console.log(`${name}: ${source} (${(statSync(source).size / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}
const wasmSource = resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm");
if (await copyWasm(wasmSource, "bun.wasm")) {
  const quickjsSource = join(dirname(wasmSource), "quickjs.wasm");
  if (!(await copyWasm(quickjsSource, "quickjs.wasm"))) {
    throw new Error(`QuickJS core requires its matching side module: ${quickjsSource}`);
  }
}
const jscSource = resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm");
if (await copyWasm(jscSource, "bun-jsc.wasm")) {
  const side = join(dirname(jscSource), "jsc-engine.wasm");
  if (!(await copyWasm(side, "jsc-engine.wasm"))) throw new Error(`JSC core requires its matching side module: ${side}`);
}
await copyWasm(resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm"), "bun-browser.wasm");

await copyWasm(resolve(here, process.env.BUN_TOOLS_WASM ?? "../dist/bun-tools.wasm"), "bun-tools.wasm");

async function templateFiles(directory: string, base = directory): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) Object.assign(files, await templateFiles(path, base));
    else files[relative(base, path)] = await Bun.file(path).text();
  }
  return files;
}

for (const template of templates) {
  const files = await templateFiles(join(here, template.directory));
  const bytes = new TextEncoder().encode(JSON.stringify({ files }));
  engineBuilds[template.file] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(out, template.file), bytes);
  console.log(`${template.id}: ${Object.keys(files).length} project source files`);
}

await Bun.write(join(out, "engine-builds.json"), JSON.stringify(engineBuilds));
const index = await Bun.file(join(here, "index.html")).text();
await buildShellAssets(here, out);
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>globalThis.__bunwasmBuilds=${JSON.stringify(engineBuilds)}</script>`));

for (const output of page.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
