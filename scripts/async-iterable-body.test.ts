import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInContext } from "node:vm";
import { runOwned, sourceRuntime } from "./fixtures/stream-consumers-runtime";
import { comparableLifecycle } from "../tests/fixtures/async-iterable-body/lifecycle-comparison";

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

test("only the two invalid-chunk cases compare by TypeError class", () => {
  const guestRows: [string, unknown][] = lifecycleExpected.map(([name, value]: [string, unknown]) => {
    if (name !== "promise-chunk" && name !== "thenable-chunk") return [name, value];
    return [name, Object.assign({}, value, { error: "TypeError: Expected an ArrayBuffer or ArrayBufferView" })];
  });
  expect(comparableLifecycle(guestRows)).toEqual(comparableLifecycle(lifecycleExpected));
  expect(() => comparableLifecycle([["promise-chunk", { error: "Error: wrong class" }]])).toThrow("Wrong promise-chunk error");
  expect(() => comparableLifecycle([["thenable-chunk", { gets: 0 }]])).toThrow("Missing thenable-chunk TypeError");
});

test("constructor, cancellation, receiver, getter and falsy identity results remain strict", () => {
  const changes: [string, unknown][] = [
    ["acquisition", { constructed: ["get"], idle: ["get"], text: "a", events: [] }],
    ["pending-cancel", { beforeRelease: { events: ["next"], state: "pending" }, events: ["next"], readDone: false, locked: true }],
    ["cancel-without-read", ["iterator:true"]],
    ["getter-error", { original: false }],
    ["next-validation", { constructed: [], idle: [], text: "a", events: ["next:false"] }],
    ["falsy-errors", [true, false, true, true, true]],
    ["return-errors", [true, true, true, false, true]],
  ];
  for (const [name, changed] of changes) {
    const original = lifecycleExpected.find((row: [string, unknown]) => row[0] === name);
    expect(original).toBeDefined();
    expect(comparableLifecycle([[name, changed]])).not.toEqual(comparableLifecycle([original]));
  }
});
