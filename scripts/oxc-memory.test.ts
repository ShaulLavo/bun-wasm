import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-oxc-memory-"));
const measurements: unknown[] = [];
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (process.env.BUNWASM_OXC_MEMORY_RESULT) writeFileSync(process.env.BUNWASM_OXC_MEMORY_RESULT, JSON.stringify({ measurements, removedScratch: scratch }, null, 2) + "\n");
});
const bindings = [
  { name: "parser", initial: 980, tar: "30e515f96d93dc421b81874403f1f89a6a7bc5eda0983e66a3dd31f4bf292884" },
  { name: "transform", initial: 981, tar: "de3ee7cebc234fcde803c32d916e870d6d5c43514d933e0c98dcb38bb2983c30" },
  { name: "minify", initial: 981, tar: "b75bb32c831cd9517e50440b728ab83f1da1b03e2d3fb06b21b2a1bc052a4cf1" },
];
const binary = join(scratch, "target/release/oxc-memory-check");

function command(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`);
  return result.stdout.toString();
}
function adapt(path: string): string {
  const output = join(scratch, "adapted.cjs");
  command([binary, path, output]);
  return readFileSync(output, "utf8");
}

beforeAll(async () => {
  const fixture = resolve(import.meta.dir, "fixtures/oxc-memory-adapter.rs");
  writeFileSync(join(scratch, "Cargo.toml"), `[package]\nname = "oxc-memory-check"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n[dependencies]\nsha2 = "=0.10.9"\n[[bin]]\nname = "oxc-memory-check"\npath = ${JSON.stringify(fixture)}\n`);
  command(["cargo", "build", "--quiet", "--release", "--manifest-path", join(scratch, "Cargo.toml"), "--target-dir", join(scratch, "target")]);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true, dependencies: {
    "@napi-rs/wasm-runtime": "1.2.7", "@emnapi/core": "1.11.3", "@emnapi/runtime": "1.11.3",
  } }));
  const installed = Bun.spawnSync(["bun", "install", "--ignore-scripts", "--no-progress"], { cwd: scratch, stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  if (installed.exitCode !== 0) throw new Error(installed.stderr.toString());
  for (const { name, tar } of bindings) {
    const url = `https://registry.npmjs.org/@oxc-${name}/binding-wasm32-wasi/-/binding-wasm32-wasi-0.94.0.tgz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    expect(response.ok).toBe(true);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(tar);
    const archive = join(scratch, `${name}.tgz`);
    writeFileSync(archive, bytes);
    const directory = join(scratch, "node_modules", `@oxc-${name}/binding-wasm32-wasi`);
    mkdirSync(directory, { recursive: true });
    command(["tar", "-xzf", archive, "--strip-components=1", "-C", directory]);
  }
}, 120_000);

for (const { name, initial } of bindings) {
  const directory = join(scratch, "node_modules", `@oxc-${name}/binding-wasm32-wasi`);
  const path = join(directory, `${name}.wasi.cjs`);
  const wasm = join(directory, `${name}.wasm32-wasi.wasm`);
  test(`${name} changes only the published initial memory and preserves source positions`, () => {
    const source = readFileSync(path, "utf8");
    const adapted = adapt(path);
    expect(adapted).toBe(source.replace("initial: 4000,", `initial: ${initial} ,`));
    expect(adapted.length).toBe(source.length);
    expect(adapted).toContain("maximum: 65536,\n  shared: true,");
    expect(readFileSync(path, "utf8")).toBe(source);
  });
  test(`${name} rejects one page below its real imported minimum`, () => {
    const module = new WebAssembly.Module(readFileSync(wasm));
    const imports: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      const namespace = imports[entry.module] ??= {};
      namespace[entry.name] = entry.kind === "memory"
        ? new WebAssembly.Memory({ initial: initial - 1, maximum: 65536, shared: true })
        : () => { throw new Error("A minimum rejection must precede every imported call"); };
    }
    expect(() => new WebAssembly.Instance(module, imports)).toThrow(WebAssembly.LinkError);
  });
  test(`${name} preserves real APIs, async outcomes and caller errors`, () => {
    const probe = new URL("./fixtures/oxc-memory-probe.ts", import.meta.url).pathname;
    const output = join(scratch, `${name}-adapted.cjs`);
    const adapter = JSON.parse(command([binary, path, output]));
    const stock = JSON.parse(command(["node", probe, scratch, "stock", name]));
    const small = JSON.parse(command(["node", probe, scratch, "small", name, output]));
    expect(stock.loadError).toBeUndefined();
    expect(small.loadError).toBeUndefined();
    expect(small.output).toEqual(stock.output);
    expect(small.asyncResult).toEqual(stock.asyncResult);
    expect(small.badArgument).toEqual(stock.badArgument);
    expect(stock.startedBytes).toEqual([4000 * 65536]);
    expect(small.startedBytes).toEqual([initial * 65536]);
    expect(small.grownBytes[0]).toBeLessThan(stock.grownBytes[0]);
    const nativeBun = [];
    for (const mode of ["stock", "small"]) {
      const result = JSON.parse(command(["bun", probe, scratch, mode, name, output]));
      // Native Bun 1.4.4 lacks WASI.initialize; this control records the stock failure too.
      if (result.loadError) expect(result.loadError.message).toContain("wasi.initialize");
      else expect(result.output).toEqual(stock.output);
      nativeBun.push(result);
    }
    measurements.push({ name, adapter, stock, small, nativeBun });
  }, 90_000);
  test(`${name} keeps changed sources, changed binaries, debug files and unrelated paths untouched`, () => {
    const source = readFileSync(path, "utf8");
    writeFileSync(path, source + "\n");
    expect(adapt(path)).toBe(source + "\n");
    writeFileSync(path, source);
    const original = readFileSync(wasm);
    writeFileSync(wasm, original.subarray(0, original.length - 1));
    expect(adapt(path)).toBe(source);
    writeFileSync(wasm, original);
    const debug = join(directory, `${name}.wasm32-wasi.debug.wasm`);
    writeFileSync(debug, original);
    expect(adapt(path)).toBe(source);
    rmSync(debug);
    const unrelated = join(scratch, `${name}.wasi.cjs`);
    copyFileSync(path, unrelated);
    expect(adapt(unrelated)).toBe(source);
    rmSync(wasm);
    expect(adapt(path)).toBe(source);
    writeFileSync(wasm, original);
  });
}
