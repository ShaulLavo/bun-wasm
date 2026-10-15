// Builds the playground into web/dist as plain static files.
// BUN_WASM=<path> overrides the default ../dist/bun.wasm.
import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const out = join(here, "dist");
const wasmSource = resolve(here, process.env.BUN_WASM ?? "../dist/bun.wasm");

rmSync(out, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(here, "src/main.ts"), join(here, "src/worker.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "linked",
  naming: "[name].[ext]",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The service worker is a classic script (module service workers are newer in Safari).
const sw = await Bun.build({
  entrypoints: [join(here, "src/sw.ts")],
  outdir: out,
  target: "browser",
  format: "iife",
  minify: true,
  naming: "[name].[ext]",
});
if (!sw.success) {
  for (const log of sw.logs) console.error(log);
  process.exit(1);
}

await Bun.write(join(out, "index.html"), Bun.file(join(here, "index.html")));
// Cloudflare Static Assets headers: cross-origin isolation (SharedArrayBuffer for
// Atomics.wait sleeps and the networking bridge). serve.ts sends the same locally.
await Bun.write(join(out, "_headers"), Bun.file(join(here, "_headers")));

// Each wasm gets a .gz twin; serve.ts sends that when the browser accepts gzip.
async function copyWasm(source: string, name: string): Promise<boolean> {
  if (!existsSync(source)) return false;
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  // Only the .gz ships: the page decompresses it, and static hosts cap file sizes
  // (Cloudflare: 25 MiB; bun-jsc.wasm is 43 MB raw, 12 MB gzipped).
  await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(bytes, { level: 9 }));
  console.log(`${name}: copied ${source} (${(statSync(source).size / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}
if (!(await copyWasm(wasmSource, "bun.wasm"))) {
  console.warn(`bun.wasm: ${wasmSource} not found; the site will say bun.wasm is missing (or pass ?wasm=<url>).`);
}
const jscSource = resolve(here, process.env.BUN_JSC_WASM ?? "../dist/bun-jsc.wasm");
if (!(await copyWasm(jscSource, "bun-jsc.wasm"))) {
  console.warn(`bun-jsc.wasm: ${jscSource} not found; the JavaScriptCore engine option will fail to load.`);
}

for (const output of result.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
