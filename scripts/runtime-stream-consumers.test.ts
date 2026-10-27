import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runOwned, sourceModuleTools, sourceRuntime } from "./fixtures/stream-consumers-runtime";
import { consumptionControls } from "./fixtures/stream-consumers-control";
import { selectChecks } from "./test-checks";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-stream-consumers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("stream consumers resolves through public require and import metadata with emitted callable exports", async () => {
  const source = sourceRuntime(scratch);
  const require = source.runtime.makeRequire("/entry.ts");
  const consumers = source.consumers();
  expect(require("stream/consumers")).toBe(consumers);
  expect(require.resolve("stream/consumers")).toBe("stream/consumers");
  expect(require.resolve("node:stream/consumers")).toBe("node:stream/consumers");
  const meta = { resolve: (_specifier: string) => "", resolveSync: (_specifier: string) => "" };
  source.runtime.initImportMeta(meta, "/entry.ts", false);
  expect(meta.resolve("stream/consumers")).toBe("node:stream/consumers");
  expect(meta.resolveSync("node:stream/consumers")).toBe("node:stream/consumers");
  const module = require("node:module");
  expect(module.isBuiltin("stream/consumers")).toBe(true);
  expect(module.builtinModules).toContain("stream/consumers");
  expect(Object.keys(consumers).sort()).toEqual(["arrayBuffer", "blob", "buffer", "bytes", "json", "text"]);
  for (const value of Object.values(consumers)) expect(typeof value).toBe("function");
  expect(source.emitted.get("stream_consumers")).toContain("async function text(");
  const tools = sourceModuleTools(scratch);
  expect(tools("builtin", ["stream/consumers", "node:stream/consumers"]).trim().split("\n"))
    .toEqual(["node:stream/consumers", "node:stream/consumers"]);
  const key = `stream-consumers-${process.pid}`;
  const path = join(scratch, "consumers.mjs");
  const value = `globalThis[${JSON.stringify(key)}]`;
  writeFileSync(path, `import.meta.m = { value: ${value}, default: ${value} };\n${tools("wrapper", Object.keys(consumers))}`);
  Object.defineProperty(globalThis, key, { value: consumers, configurable: true });
  try {
    const imported = await import(pathToFileURL(path).href);
    expect(imported.default).toBe(consumers);
    for (const name of Object.keys(consumers)) expect(imported[name]).toBe(Reflect.get(consumers, name));
    expect(await imported.text(["Prisma ", "stdin"])).toBe("Prisma stdin");
  } finally { Reflect.deleteProperty(globalThis, key); }
});

test("stream consumers regression is selected by CI and local runtime checks", () => {
  for (const owner of ["runtime", "local-runtime"]) expect(selectChecks(owner)).toContain("scripts/runtime-stream-consumers.test.ts");
});

test("emitted consumers use real portable web and Node streams", async () => {
  const source = sourceRuntime(scratch);
  const rows = await source.run(() => consumptionControls(source.consumers(), source.constructors()));
  expect(rows.length).toBeGreaterThanOrEqual(14);
});

for (const engine of ["node", "bun"]) {
  test(`${engine} oracle and real-source factory agree on consumption and cleanup`, () => {
    const fixture = join(import.meta.dirname, "fixtures/stream-consumers-control.ts");
    const native = runOwned(engine, [fixture, "native"]);
    expect(native.stderr).toBe("");
    expect(native.status).toBe(0);
    const directory = join(scratch, engine);
    mkdirSync(directory);
    const source = runOwned(engine, [fixture, "source", directory]);
    expect(source.stderr).toBe("");
    expect(source.status).toBe(0);
    const common = (row: string) => !row.startsWith("bytes") && !row.startsWith("web readable: mixed") && !row.startsWith("text/json: invalid");
    expect(JSON.parse(source.stdout).filter(common)).toEqual(JSON.parse(native.stdout).filter(common));
    expect(JSON.parse(source.stdout)).toContain("web readable: mixed string and split UTF-8 = x€");
    expect(JSON.parse(native.stdout)).toContain(`web readable: mixed string and split UTF-8 = ${engine === "bun" ? "�x��" : "x€"}`);
    expect(JSON.parse(source.stdout)).toContain("text/json: invalid chunks close iterators and destroy Node streams; web cancels on invalid chunk");
    expect(JSON.parse(native.stdout)).toContain(`text/json: invalid chunks close iterators and destroy Node streams; web ${engine === "bun" ? "collects until source error" : "cancels on invalid chunk"}`);
  });
}
