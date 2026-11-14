import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-rolldown-memory-"));
const directory = join(scratch, "node_modules/@rolldown/binding-wasm32-wasi");
const loader = join(directory, "rolldown-binding.wasi.cjs");
const wasm = join(directory, "rolldown-binding.wasm32-wasi.wasm");
const binary = join(scratch, "target/release/rolldown-memory-check");
const output = join(scratch, "adapted.cjs");
const measurements: unknown[] = [];
const loaders = ["rolldown-binding.wasi.cjs", "rolldown-binding.wasi-browser.js"];
const browserResult = process.env.BUNWASM_ROLLDOWN_BROWSER_RESULT;
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (process.env.BUNWASM_ROLLDOWN_MEMORY_RESULT) writeFileSync(process.env.BUNWASM_ROLLDOWN_MEMORY_RESULT,
    JSON.stringify({ measurements, removedScratch: scratch }, null, 2) + "\n");
});

function command(args: string[], cwd = scratch): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`);
  return result.stdout.toString();
}
function adapt(path = loader): string {
  command([binary, path, output]);
  return readFileSync(output, "utf8");
}

beforeAll(async () => {
  const fixture = resolve(import.meta.dir, "fixtures/rolldown-memory-adapter.rs");
  writeFileSync(join(scratch, "Cargo.toml"), `[package]\nname = "rolldown-memory-check"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n[dependencies]\nsha2 = "=0.10.9"\n[[bin]]\nname = "rolldown-memory-check"\npath = ${JSON.stringify(fixture)}\n`);
  command(["cargo", "build", "--quiet", "--release", "--manifest-path", join(scratch, "Cargo.toml"), "--target-dir", join(scratch, "target")]);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true, dependencies: {
    "@napi-rs/wasm-runtime": "1.2.6", "@emnapi/core": "2.0.0-beta.2", "@emnapi/runtime": "2.0.0-beta.2", "rolldown": "1.2.16",
    "@tybys/wasm-util": "0.10.4", "@emnapi/wasi-threads": "2.2.0",
    ...(browserResult ? { esbuild: "0.28.2", playwright: "1.64.1" } : {}),
  } }));
  command(["bun", "install", "--ignore-scripts", "--no-progress"]);
  const response = await fetch("https://registry.npmjs.org/@rolldown/binding-wasm32-wasi/-/binding-wasm32-wasi-1.2.16.tgz",
    { signal: AbortSignal.timeout(30_000) });
  expect(response.ok).toBe(true);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("003f64a43c6e77a24228c02538a89c87ded2cb375ea3c091d82b19d9e8aae17b");
  const archive = join(scratch, "binding.tgz");
  writeFileSync(archive, bytes);
  mkdirSync(directory, { recursive: true });
  command(["tar", "-xzf", archive, "--strip-components=1", "-C", directory]);
}, 120_000);

test.each(loaders)("%s reduces only initial capacity and preserves source positions", filename => {
  const loader = join(directory, filename);
  const source = readFileSync(loader, "utf8");
  const adapted = adapt(loader);
  expect(adapted).toBe(source.replace("initial: 16384,", "initial: 1001 ,"));
  expect(adapted.length).toBe(source.length);
  expect(adapted).toContain("maximum: 65536,\n  shared: true,");
  expect(readFileSync(loader, "utf8")).toBe(source);
  expect(JSON.parse(command([binary, loader, output])).dependsOnBinary).toBe(true);
});

test("Rolldown rejects one page below the real binary minimum before imports run", () => {
  const module = new WebAssembly.Module(readFileSync(wasm));
  const imports: WebAssembly.Imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    const namespace = imports[entry.module] ??= {};
    namespace[entry.name] = entry.kind === "memory"
      ? new WebAssembly.Memory({ initial: 1000, maximum: 65536, shared: true })
      : () => { throw new Error("Minimum rejection must precede every imported call"); };
  }
  expect(() => new WebAssembly.Instance(module, imports)).toThrow(WebAssembly.LinkError);
});

test("Rolldown real sync, async, bundling, caller errors and disposal survive the reduction", () => {
  adapt();
  const probe = new URL("./fixtures/rolldown-memory-probe.ts", import.meta.url).pathname;
  const packageRoot = join(scratch, "node_modules/rolldown");
  const stock = JSON.parse(command(["node", probe, scratch, "stock", packageRoot]));
  const small = JSON.parse(command(["node", probe, scratch, "small", packageRoot, output]));
  expect(stock.loadError).toBeUndefined();
  expect(small.loadError).toBeUndefined();
  expect(small.output).toEqual(stock.output);
  expect(small.badArgument).toEqual(stock.badArgument);
  expect(small.phases).toEqual(stock.phases);
  expect(small.phases).toContain("async:return");
  expect(small.phases).toContain("bundle:return");
  expect(small.phases).toContain("dispose:return");
  expect(stock.descriptors).toEqual([{ initial: 16384, maximum: 65536, shared: true }]);
  expect(small.descriptors).toEqual([{ initial: 1001, maximum: 65536, shared: true }]);
  expect(small.grownBytes[0]).toBeLessThan(stock.grownBytes[0]);
  measurements.push({ stock, small });
}, 90_000);

test.skipIf(!browserResult)("compiled Rolldown browser output preserves real Chromium and WebKit APIs", () => {
  if (!browserResult) throw new Error("Missing explicit browser result destination");
  const script = new URL("./rolldown-memory-browser.ts", import.meta.url).pathname;
  command(["bun", script, scratch, binary, browserResult]);
}, 180_000);

test.each(loaders)("%s keeps changed source, binaries, debug selection, and unrelated paths untouched", filename => {
  const loader = join(directory, filename);
  const source = readFileSync(loader, "utf8");
  writeFileSync(loader, source + "\n");
  expect(adapt(loader)).toBe(source + "\n");
  writeFileSync(loader, source);
  const other = filename === "rolldown-binding.wasi.cjs" ? "rolldown-binding.wasi-browser.js" : "rolldown-binding.wasi.cjs";
  const swapped = readFileSync(join(directory, other), "utf8");
  writeFileSync(loader, swapped);
  expect(adapt(loader)).toBe(swapped);
  writeFileSync(loader, source);
  const original = readFileSync(wasm);
  writeFileSync(wasm, original.subarray(0, original.length - 1));
  expect(adapt(loader)).toBe(source);
  const firstByte = original.readUInt8(0);
  original.writeUInt8(firstByte ^ 1, 0);
  writeFileSync(wasm, original);
  expect(adapt(loader)).toBe(source);
  original.writeUInt8(firstByte, 0);
  writeFileSync(wasm, original);
  const debug = join(directory, "rolldown-binding.wasm32-wasi.debug.wasm");
  writeFileSync(debug, original);
  expect(adapt(loader)).toBe(source);
  rmSync(debug);
  const unrelated = join(scratch, filename);
  copyFileSync(loader, unrelated);
  expect(adapt(unrelated)).toBe(source);
  rmSync(wasm);
  expect(adapt(loader)).toBe(source);
  writeFileSync(wasm, original);
});
