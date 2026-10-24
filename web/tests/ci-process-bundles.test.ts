import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processBundle } from "../scripts/ci-process-bundles";

async function withScratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "process-bundle-"));
  const captured = process.env.BUN_WASM_PROCESS_BUNDLES;
  try { await run(directory); }
  finally {
    if (captured === undefined) delete process.env.BUN_WASM_PROCESS_BUNDLES;
    else process.env.BUN_WASM_PROCESS_BUNDLES = captured;
    await rm(directory, { recursive: true, force: true });
  }
}

test("a requested missing Bun acceptance bundle fails without a build fallback", async () => {
  await withScratch(async directory => {
    process.env.BUN_WASM_PROCESS_BUNDLES = join(directory, "absent");
    await expect(processBundle("bun-runtime-proc", join(directory, "out"))).rejects.toThrow("Invalid captured bun-runtime-proc bundle");
  });
});

test("the generic runtime-proc controller cannot stand in for Bun acceptance", async () => {
  await withScratch(async directory => {
    const bundle = join(directory, "bun-runtime-proc");
    await mkdir(bundle);
    await Bun.write(join(bundle, "index.html"), '<script type="module" src="./runtime-proc-browser-main.js"></script>');
    await Bun.write(join(bundle, "runtime-proc-browser-main.js"), "globalThis.runtimeProcResult = { ok: true };");
    process.env.BUN_WASM_PROCESS_BUNDLES = directory;
    await expect(processBundle("bun-runtime-proc", join(directory, "out"))).rejects.toThrow("Invalid captured bun-runtime-proc bundle");
  });
});

async function hashes(directory: string): Promise<Record<string, string>> {
  const entries = Array.from(new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true }));
  return Object.fromEntries(await Promise.all(entries.map(async name => [name, new Bun.CryptoHasher("sha256").update(await Bun.file(join(directory, name)).bytes()).digest("hex")])));
}

async function consumeWithoutBuild(root: string, out: string): Promise<void> {
  const helper = new URL("../scripts/ci-process-bundles.ts", import.meta.url).pathname;
  const code = `import { processBundle } from ${JSON.stringify(helper)}; Bun.build = () => { throw Error("consumer must not build"); }; await processBundle("bun-runtime-proc", ${JSON.stringify(out)});`;
  const child = Bun.spawn([process.execPath, "--eval", code], {
    env: { ...process.env, BUN_WASM_PROCESS_BUNDLES: root }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
}

async function checkCopies(directory: string): Promise<void> {
  const bundle = join(directory, "bun-runtime-proc");
  await mkdir(bundle);
  await Bun.write(join(bundle, "index.html"), '<!doctype html><script type="module" src="./bun-runtime-proc-main.js"></script>');
  for (const name of ["bun-runtime-proc-main.js", "worker.js", "fs-worker.js"]) await Bun.write(join(bundle, name), `test-only captured bytes: ${name}`);
  const source = new Bun.CryptoHasher("sha256").update(await Bun.file(new URL("./bun-runtime-proc-main.ts", import.meta.url)).bytes()).digest("hex");
  await Bun.write(join(bundle, "bundle.json"), JSON.stringify({ fixture: "bun-runtime-proc", source, files: await hashes(bundle) }));
  expect(await Bun.file(join(bundle, "index.html")).text()).toContain('src="./bun-runtime-proc-main.js"');
  expect(await Bun.file(join(bundle, "bun-runtime-proc-main.js")).exists()).toBe(true);
  const before = await hashes(bundle);
  for (const browser of ["chromium", "firefox", "webkit"]) {
    const out = join(directory, browser);
    await consumeWithoutBuild(directory, out);
    expect(await hashes(out)).toEqual(before);
  }
  process.env.BUN_WASM_PROCESS_BUNDLES = directory;
  await Bun.write(join(bundle, "bun-runtime-proc-main.js"), "wrong controller bytes");
  await expect(processBundle("bun-runtime-proc", join(directory, "tampered"))).rejects.toThrow("Invalid captured bun-runtime-proc bundle");
  await cp(join(directory, "chromium"), bundle, { recursive: true });
  const receipt = Bun.file(join(bundle, "bundle.json"));
  const value: unknown = await receipt.json();
  if (!value || typeof value !== "object") throw new Error("Expected test receipt object");
  await Bun.write(receipt, JSON.stringify({ ...value, source: "0".repeat(64) }));
  await expect(processBundle("bun-runtime-proc", join(directory, "stale"))).rejects.toThrow("Invalid captured bun-runtime-proc bundle");
}

test("three consumers copy the distinct Bun acceptance bundle without compiling", async () => {
  await withScratch(checkCopies);
}, 30_000);
