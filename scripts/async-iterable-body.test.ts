import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { runOwned, sourceRuntime } from "./fixtures/stream-consumers-runtime";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-iterable-body-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = join(import.meta.dirname, "../tests/fixtures/async-iterable-body");
const lifecycleExpected = JSON.parse(readFileSync(join(fixture, "lifecycle-expected.json"), "utf8"));
const expected = JSON.parse(readFileSync(join(fixture, "expected.txt"), "utf8"));

test("Astro-shaped async iterable bodies flow through the real Response factory", async () => {
  const source = sourceRuntime(scratch);
  const text = readFileSync(join(fixture, "controls.ts"), "utf8").replace("export async function bodyControls()", "globalThis.bodyControls = async function bodyControls()");
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
  const rows = await source.run(() => runInContext(`${emitted}\nbodyControls()`, source.context));
  expect(rows).toEqual(expected);
});

for (const engine of ["node", process.execPath]) {
  test(`${engine} accepts the same iterable body and cleanup controls`, () => {
    const result = runOwned(engine, [join(fixture, "index.ts")]);
    expect(result.status, result.stderr).toBe(0);
    const rows: string[] = JSON.parse(result.stdout);
    const common = (row: string) => !row.startsWith("closed:") && !row.startsWith("invalid:");
    expect(rows.filter(common)).toEqual(expected.filter(common));
    if (engine !== "node") expect(rows).toEqual(expected);
  });
}

function comparableLifecycle(rows: [string, unknown][]) {
  return rows.map(([name, value]) => {
    if (name !== "promise-chunk" && name !== "thenable-chunk") return [name, value];
    if (value === null || typeof value !== "object" || !("error" in value)) throw new Error(`Missing ${name} TypeError`);
    if (typeof value.error !== "string" || !value.error.startsWith("TypeError:")) throw new Error(`Wrong ${name} error`);
    return [name, Object.assign({}, value, { error: "TypeError" })];
  });
}

test("captured producer acquisition and cancellation match the retained native Bun controls", async () => {
  const source = sourceRuntime(scratch);
  const text = readFileSync(join(fixture, "lifecycle-controls.ts"), "utf8").replace("export async function lifecycleControls()", "globalThis.lifecycleControls = async function lifecycleControls()");
  const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
  const rows = await source.run<[string, unknown][]>(() => runInContext(`${emitted}\nlifecycleControls()`, source.context));
  expect(comparableLifecycle(rows)).toEqual(comparableLifecycle(lifecycleExpected));
});

test("native Bun retains the measured lifecycle contract", () => {
  const result = runOwned(process.execPath, [join(fixture, "index.ts"), "--lifecycle"], 5000);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(lifecycleExpected);
});
