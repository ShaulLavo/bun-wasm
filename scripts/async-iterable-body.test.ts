import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { runOwned, sourceRuntime } from "./fixtures/stream-consumers-runtime";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-iterable-body-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = join(import.meta.dirname, "../tests/fixtures/async-iterable-body");
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
