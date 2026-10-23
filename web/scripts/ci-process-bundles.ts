import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBrowserEntries, resolveRuntimePackage } from "../../scripts/browser-build";

type Fixture = "supervisor" | "runtime-proc" | "interrupt";
const web = resolve(import.meta.dir, "..");

export async function processBundle(fixture: Fixture, out: string): Promise<void> {
  const captured = process.env.BUN_WASM_PROCESS_BUNDLES;
  if (captured) {
    await cp(join(captured, fixture), out, { recursive: true });
    return;
  }
  if (fixture === "interrupt") {
    const runtime = resolveRuntimePackage(join(web, "tests/browser-interrupt.ts"));
    const result = await Bun.build({
      entrypoints: [join(runtime.physical, "tests/interrupt-browser.ts"), join(runtime.physical, "tests/fixtures/interrupt-browser-worker.ts")],
      outdir: out, target: "browser", format: "esm", splitting: true, minify: true,
      naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
    });
    if (!result.success) throw new AggregateError(result.logs, "Interrupt fixture build failed");
    await Bun.write(join(out, "index.html"), '<!doctype html><title>Interrupt gate</title><script type="module" src="/interrupt-browser.js"></script>');
    return;
  }
  const entry = fixture === "supervisor" ? "process-browser-main" : "runtime-proc-browser-main";
  await buildBrowserEntries([join(web, `tests/${entry}.ts`), join(web, "src/worker.ts"), join(web, "src/fs-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), `<!doctype html><script type="module" src="./${entry}.js"></script>`);
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out || process.env.BUN_WASM_PROCESS_BUNDLES) throw new Error("Usage: ci-process-bundles.ts <new-output-directory>, without captured bundles");
  await mkdir(out, { recursive: true });
  for (const fixture of ["supervisor", "runtime-proc", "interrupt"] as const) {
    await processBundle(fixture, join(out, fixture));
    console.log(`Built process fixture: ${fixture}`);
  }
}
