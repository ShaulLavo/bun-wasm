import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBrowserEntries, resolveRuntimePackage } from "../../scripts/browser-build";

type Fixture = "supervisor" | "runtime-proc" | "interrupt" | "bun-runtime-proc";
const web = resolve(import.meta.dir, "..");

async function bundleHashes(directory: string): Promise<Record<string, string>> {
  const names = Array.from(new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })).filter(name => name !== "bundle.json");
  names.sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, new Bun.CryptoHasher("sha256").update(await Bun.file(join(directory, name)).bytes()).digest("hex")])));
}

async function bunControllerHash(): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(join(web, "tests/bun-runtime-proc-main.ts")).bytes()).digest("hex");
}

async function checkBunBundle(directory: string): Promise<void> {
  try {
    const receipt: unknown = await Bun.file(join(directory, "bundle.json")).json();
    assert.ok(receipt && typeof receipt === "object" && "fixture" in receipt && "source" in receipt && "files" in receipt, "bundle receipt required");
    assert.equal(receipt.fixture, "bun-runtime-proc", "distinct Bun acceptance recipe required");
    assert.equal(receipt.source, await bunControllerHash(), "Bun controller source changed");
    const files = await bundleHashes(directory);
    for (const name of ["index.html", "bun-runtime-proc-main.js", "worker.js", "fs-worker.js", "notification-worker.js"]) assert.ok(files[name], `missing ${name}`);
    assert.deepEqual(files, receipt.files, "captured bundle bytes changed");
    assert.equal(await Bun.file(join(directory, "index.html")).text(), '<!doctype html><script type="module" src="./bun-runtime-proc-main.js"></script>', "wrong acceptance controller");
  } catch (error) {
    throw new Error(`Invalid captured bun-runtime-proc bundle at ${directory}: ${String(error)}`, { cause: error });
  }
}

export async function processBundle(fixture: Fixture, out: string): Promise<void> {
  const captured = process.env.BUN_WASM_PROCESS_BUNDLES;
  if (captured) {
    if (fixture === "bun-runtime-proc") await checkBunBundle(join(captured, fixture));
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
  const entry = fixture === "supervisor" ? "process-browser-main" : fixture === "bun-runtime-proc" ? "bun-runtime-proc-main" : "runtime-proc-browser-main";
  await buildBrowserEntries([join(web, `tests/${entry}.ts`), join(web, "src/worker.ts"), join(web, "src/fs-worker.ts"), join(web, "src/notification-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), `<!doctype html><script type="module" src="./${entry}.js"></script>`);
  if (fixture === "bun-runtime-proc") {
    await Bun.write(join(out, "bundle.json"), JSON.stringify({ fixture, source: await bunControllerHash(), files: await bundleHashes(out) }));
  }
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out || process.env.BUN_WASM_PROCESS_BUNDLES) throw new Error("Usage: ci-process-bundles.ts <new-output-directory>, without captured bundles");
  await mkdir(out, { recursive: true });
  for (const fixture of ["supervisor", "runtime-proc", "interrupt", "bun-runtime-proc"] as const) {
    await processBundle(fixture, join(out, fixture));
    console.log(`Built process fixture: ${fixture}`);
  }
}
