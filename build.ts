import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Guest builds also own dist/*.wasm; package builds must never delete or pack those files.
const out = join(import.meta.dir, "dist/package");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    join(import.meta.dir, "web/src/index.ts"),
    join(import.meta.dir, "web/src/worker-entry.ts"),
    join(import.meta.dir, "web/src/assets.ts"),
  ],
  outdir: out,
  format: "esm",
  target: "browser",
  external: ["waffle", "waffle/*"],
  splitting: true,
  naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
  sourcemap: "external",
});
if (!result.success) throw new AggregateError(result.logs, "bun-wasm package build failed");
for (const output of result.outputs) console.log(`${output.path.slice(out.length + 1)} ${(output.size / 1024).toFixed(0)} KB`);
