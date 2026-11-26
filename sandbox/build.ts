// Builds the sandbox into sandbox/dist as plain static files: the page, the shared bun worker and
// service worker from web/src, each engine's wasm (Brotli and gzip twins), and the React and vanilla template sources.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
// BUN_TOOLS_WASM overrides ../dist/bun-tools.wasm; BASH_WEB_GUESTS_DIR overrides ../dist for bash-web guests (scripts/build-bash-web-shell.sh).
import { existsSync, rmSync, statSync } from "node:fs";
import { previewWebsocketScript } from "../web/preview-build";
import { previewOriginStartup, writePreviewOriginAssets } from "../web/preview-origin-build";
import { buildBrowserEntries, buildClassicWorker, buildShellAssets, publishVersionedEntries, rewriteEntryHtml, VERSIONED_WORKER_FILES } from "../scripts/browser-build";
import { dirname, join, resolve } from "node:path";
import { templates } from "./src/template-catalog";
import { templateFiles } from "./template-files";
import { stageSharedPrograms } from "../scripts/stage-program-profiles";
import { brotliQuality, sortedBuilds, stageGuestWasm } from "../scripts/stage-guest-wasm";
import { appOutput } from "../scripts/app-output";
import { settleAll } from "../scripts/stage-wasm-sidecars";

const here = import.meta.dir;
const web = resolve(here, "../web");
// BUN_WASM_APP_OUT builds somewhere disposable instead of sandbox/dist (tests, side-by-side builds).
const out = appOutput(here);

// An invalid setting fails before the previous build is removed.
brotliQuality();
rmSync(out, { recursive: true, force: true });

// Bundle each browser realm independently and mirror worker chunks into its scope.
const page = await buildBrowserEntries([join(here, "src/main.ts"), join(web, "src/worker.ts"), join(web, "src/fs-worker.ts"), join(web, "src/notification-worker.ts")], out, { runtimeWorker: true });
// The service worker stays standalone and classic for Safari.
const sw = await buildClassicWorker(join(web, "src/sw.ts"), out, {
  __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(await previewWebsocketScript()),
}, join(here, "src/main.ts"));

await Bun.write(join(out, "index.html"), Bun.file(join(here, "index.html")));
await writePreviewOriginAssets(out);
await Bun.write(join(out, "_headers"), Bun.file(join(web, "_headers")));

// ---------- engines ----------

// Every pair is checked before any guest stages; then they compress concurrently, since Brotli
// quality 11 for a site deploy takes tens of seconds per guest.
const engineBuilds: Record<string, string> = {};
const guests: { source: string; name: string }[] = [];

function copyWasm(source: string, name: string): boolean {
  if (!existsSync(source)) {
    console.warn(`${name}: ${source} not found; that engine will say it is missing.`);
    return false;
  }
  guests.push({ source, name });
  return true;
}
const wasmSource = resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm");
if (copyWasm(wasmSource, "bun.wasm")) {
  const quickjsSource = join(dirname(wasmSource), "quickjs.wasm");
  if (!copyWasm(quickjsSource, "quickjs.wasm")) {
    throw new Error(`QuickJS core requires its matching side module: ${quickjsSource}`);
  }
}
const jscSource = resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm");
if (copyWasm(jscSource, "bun-jsc.wasm")) {
  const side = join(dirname(jscSource), "jsc-engine.wasm");
  if (!copyWasm(side, "jsc-engine.wasm")) throw new Error(`JSC core requires its matching side module: ${side}`);
}
copyWasm(resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm"), "bun-browser.wasm");

copyWasm(resolve(here, process.env.BUN_TOOLS_WASM ?? "../dist/bun-tools.wasm"), "bun-tools.wasm");
const staging = guests.map(async ({ source, name }) => {
  await stageGuestWasm(source, name, out, engineBuilds);
  console.log(`${name}: ${source} (${(statSync(source).size / 1024 / 1024).toFixed(1)} MB)`);
}).concat([stageSharedPrograms(out, engineBuilds), buildShellAssets(here, out)]);
// A failure is reported only after every writer settled, so none is still writing into dist.
await settleAll(staging);
const builds = sortedBuilds(engineBuilds);

for (const template of templates) {
  const files = await templateFiles(join(here, template.directory));
  const bytes = new TextEncoder().encode(JSON.stringify({ files }));
  builds[template.file] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(out, template.file), bytes);
  console.log(`${template.id}: ${Object.keys(files).length} project source files`);
}
const pageBuilds: Record<string, string> = {
  ...builds,
  "sw.js": new Bun.CryptoHasher("sha256").update(await Bun.file(join(out, "sw.js")).bytes()).digest("hex"),
};

const entries = await publishVersionedEntries(out);
const workerAssets = Object.fromEntries(VERSIONED_WORKER_FILES.map(name => [name, entries[name]!]));
await Bun.write(join(out, "engine-builds.json"), JSON.stringify(builds));
const index = rewriteEntryHtml(await Bun.file(join(here, "index.html")).text(), entries);
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>${previewOriginStartup()}globalThis.__bunwasmBuilds=${JSON.stringify(pageBuilds)};globalThis.__bunwasmAssets=${JSON.stringify(workerAssets)}</script>`));

for (const output of page.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
