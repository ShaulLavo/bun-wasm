import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { previewOriginAssets } from "./web/preview-origin-build";

// Guest builds also own dist/*.wasm; package builds must never delete or pack those files.
const out = join(import.meta.dir, "dist/package");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    join(import.meta.dir, "src/index.ts"),
    join(import.meta.dir, "src/worker-entry.ts"),
    join(import.meta.dir, "src/notification-worker-entry.ts"),
    join(import.meta.dir, "src/assets.ts"),
    join(import.meta.dir, "src/engine-kind.ts"),
    join(import.meta.dir, "src/preview-origins.ts"),
  ],
  outdir: out,
  format: "esm",
  target: "browser",
  external: ["waffle", "waffle/*", "@waffle-os/relay"],
  splitting: true,
  naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
  minify: { whitespace: true, syntax: true, identifiers: false },
});
if (!result.success) throw new AggregateError(result.logs, "bun-wasm package build failed");
for (const output of result.outputs) console.log(`${output.path.slice(out.length + 1)} ${(output.size / 1024).toFixed(0)} KB`);

// The files a preview host serves (`bun-wasm/preview-origins/assets/*`). They are built here because
// the service worker embeds the runtime's WebSocket client, which the package does not ship as source.
await mkdir(join(out, "preview-origin"));
for (const [name, text] of Object.entries(await previewOriginAssets())) {
  await Bun.write(join(out, "preview-origin", name), text);
  console.log(`preview-origin/${name} ${(text.length / 1024).toFixed(0)} KB`);
}
