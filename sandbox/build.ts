// Builds the sandbox into sandbox/dist as plain static files: the page, the shared bun worker and
// service worker from web/src, each engine's wasm (gzipped), and template.json, the starter project
// with its node_modules.
// BUN_WASM, JSC_WASM and BUN_BROWSER_WASM override the default ../dist/{bun,bun-jsc,bun-browser}.wasm.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const here = import.meta.dir;
const web = resolve(here, "../web");
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });

async function bundle(config: Parameters<typeof Bun.build>[0]): Promise<Awaited<ReturnType<typeof Bun.build>>> {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  return result;
}

const page = await bundle({
  entrypoints: [join(here, "src/main.ts"), join(web, "src/worker.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "linked",
  naming: "[name].[ext]",
});
// The service worker is a classic script (module service workers are newer in Safari).
const sw = await bundle({ entrypoints: [join(web, "src/sw.ts")], outdir: out, target: "browser", format: "iife", minify: true, naming: "[name].[ext]" });

// Safari may fetch a dedicated worker's initial script from the network on its first visit.
// Keep the script in its controlling scope without relying on fetch interception to bootstrap it.
await Bun.write(join(out, "__bunwasm/worker.js"), Bun.file(join(out, "worker.js")));

await Bun.write(join(out, "index.html"), Bun.file(join(here, "index.html")));
await Bun.write(join(out, "_headers"), Bun.file(join(web, "_headers")));

// ---------- engines ----------

const engineBuilds: Record<string, string> = {};

async function copyWasm(source: string, name: string): Promise<void> {
  if (!existsSync(source)) {
    console.warn(`${name}: ${source} not found; that engine will say it is missing.`);
    return;
  }
  // Only the .gz ships: the page decompresses it (hosts cap file sizes).
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  engineBuilds[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(bytes, { level: 9 }));
  console.log(`${name}: ${source} (${(statSync(source).size / 1024 / 1024).toFixed(1)} MB)`);
}
await copyWasm(resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm"), "bun.wasm");
await copyWasm(resolve(here, process.env.JSC_WASM ?? "../dist/bun-jsc.wasm"), "bun-jsc.wasm");
await copyWasm(resolve(here, process.env.BUN_BROWSER_WASM ?? "../dist/bun-browser.wasm"), "bun-browser.wasm");

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
const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), "bun-wasm-sandbox-template-"));
try {
  await Bun.write(join(scratch, "package.json"), Bun.file(join(template, "package.json")));
  const install = Bun.spawnSync(["bun", "install", "--linker", "hoisted", "--no-save"], { cwd: scratch, stdout: "inherit", stderr: "inherit" });
  if (install.exitCode !== 0) throw new Error("bun install failed");
  const devTs = files[".dev/dev.ts"] ?? "";
  const depsMatch = /const DEPS = (\[[^\]]*\]);/.exec(devTs);
  if (!depsMatch) throw new Error("template/.dev/dev.ts has no `const DEPS = [...]` list");
  const deps: string[] = JSON.parse(depsMatch[1]!);
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

await Bun.write(join(out, "engine-builds.json"), JSON.stringify(engineBuilds));
const index = await Bun.file(join(here, "index.html")).text();
await Bun.write(join(out, "index.html"), index.replace("<head>", `<head><script>globalThis.__bunwasmBuilds=${JSON.stringify(engineBuilds)}</script>`));

for (const output of page.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
