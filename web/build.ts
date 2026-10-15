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

if (existsSync(wasmSource)) {
  await Bun.write(join(out, "bun.wasm"), Bun.file(wasmSource));
  console.log(`bun.wasm: copied ${wasmSource} (${(statSync(wasmSource).size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.warn(`bun.wasm: ${wasmSource} not found; the site will say bun.wasm is missing (or pass ?wasm=<url>).`);
}

for (const output of result.outputs.concat(sw.outputs)) console.log(`${output.path.slice(out.length + 1)}  ${(output.size / 1024).toFixed(0)} KB`);
