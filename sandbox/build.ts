// Builds the sandbox into sandbox/dist as plain static files: the page, the shared bun worker and
// service worker from web/src, each engine's wasm (gzipped), and the React and vanilla template sources.
// The React template includes the dependency sources Bun bundles in the browser.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
// BUN_TOOLS_WASM overrides ../dist/bun-tools.wasm; BASH_WEB_SHELL_WASM and BASH_WEB_ENV_WASM override ../dist/bash-web-shell.wasm and ../dist/bash-web-env.wasm.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { previewWebsocketScript } from "../web/preview-build";
import { buildBrowserEntries, buildClassicWorker, buildShellAssets } from "../scripts/browser-build";
import { dirname, join, relative, resolve } from "node:path";

const here = import.meta.dir;
const web = resolve(here, "../web");
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });

async function bundle(config: Parameters<typeof Bun.build>[0]): Promise<Awaited<ReturnType<typeof Bun.build>>> {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Sandbox bundle failed");
  }
  return result;
}

// Bundle each browser realm independently and mirror worker chunks into its scope.
const page = await buildBrowserEntries([join(here, "src/main.ts"), join(web, "src/worker.ts"), join(web, "src/fs-worker.ts")], out, { runtimeWorker: true });
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
await copyWasm(resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm"), "bun-jsc.wasm");
await copyWasm(resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm"), "bun-browser.wasm");

await copyWasm(resolve(here, process.env.BUN_TOOLS_WASM ?? "../dist/bun-tools.wasm"), "bun-tools.wasm");

// ---------- the starter project ----------

const template = join(here, "template");
const files: Record<string, string> = {};
function addTree(dir: string, base: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) addTree(path, base);
    else files[relative(base, path)] = "";
  }
}
addTree(template, template);
for (const path of Object.keys(files)) files[path] = await Bun.file(join(template, path)).text();

// node_modules: a native `bun install` of the template's package.json, keeping only the files the
// dev server's dependency bundle reads (development builds), plus each package's package.json and LICENSE.
const scratch = mkdtempSync(join(process.env.SCRATCH ?? "/work/tmp", "bun-wasm-sandbox-template-"));
try {
  await Bun.write(join(scratch, "package.json"), Bun.file(join(template, "package.json")));
  const install = Bun.spawnSync(["bun", "install", "--linker", "hoisted", "--no-save"], { cwd: scratch, stdout: "inherit", stderr: "inherit" });
  if (install.exitCode !== 0) throw new Error("bun install failed");
  const deps = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client", "react-refresh/runtime"];
  const entries = await Promise.all(
    deps.map(async (spec, i) => {
      const entry = join(scratch, `entry-${i}.js`);
      await Bun.write(entry, `import * as m from ${JSON.stringify(spec)}; console.log(m);\n`);
      return entry;
    }),
  );
  const graph = await bundle({ entrypoints: entries, target: "browser", metafile: true, define: { "process.env.NODE_ENV": '"development"' } });
  const needed = new Set<string>();
  for (const input of Object.keys(graph.metafile!.inputs)) {
    const path = resolve(input); // metafile paths are relative to the working directory
    const rel = relative(scratch, path);
    if (!rel.startsWith("node_modules/")) continue;
    needed.add(rel);
    const pkg = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(rel)![1];
    needed.add(`node_modules/${pkg}/package.json`);
    if (existsSync(join(scratch, `node_modules/${pkg}/LICENSE`))) needed.add(`node_modules/${pkg}/LICENSE`);
  }
  for (const rel of Array.from(needed).sort()) files[rel] = await Bun.file(join(scratch, rel)).text();
  console.log(`template: ${Object.keys(files).length} files, ${needed.size} from node_modules`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const templateBytes = new TextEncoder().encode(JSON.stringify({ files }));
engineBuilds["template.json"] = new Bun.CryptoHasher("sha256").update(templateBytes).digest("hex");
await Bun.write(join(out, "template.json"), templateBytes);

const vanillaFiles: Record<string, string> = {};
async function readTree(dir: string, base: string): Promise<void> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) await readTree(path, base);
    else vanillaFiles[relative(base, path)] = await Bun.file(path).text();
  }
}
const vanilla = join(here, "template-vanilla");
await readTree(vanilla, vanilla);
const vanillaBytes = new TextEncoder().encode(JSON.stringify({ files: vanillaFiles }));
engineBuilds["template-vanilla.json"] = new Bun.CryptoHasher("sha256").update(vanillaBytes).digest("hex");
await Bun.write(join(out, "template-vanilla.json"), vanillaBytes);

await Bun.write(join(out, "engine-builds.json"), JSON.stringify(engineBuilds));
const index = await Bun.file(join(here, "index.html")).text();
await buildShellAssets(here, out);
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>globalThis.__bunwasmBuilds=${JSON.stringify(engineBuilds)}</script>`));

for (const output of page.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
