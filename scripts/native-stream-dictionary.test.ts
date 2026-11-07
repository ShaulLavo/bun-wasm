import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium, webkit } from "playwright";
import { nativeStreamBridgeSource } from "./fixtures/native-stream-source";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const controls = transpiler.transformSync(readFileSync(new URL("../web/tests/native-stream-dictionary-controls.ts", import.meta.url), "utf8")).replaceAll("export function", "function").replaceAll("export async function", "async function");
const initialize = nativeStreamBridgeSource();

test("ordinary dictionaries reach the actual Node native constructor", () => {
  const code = `import { types } from 'node:util';
    for (const Ctor of [ReadableStream, WritableStream]) {
      Reflect.deleteProperty(Ctor.prototype, Symbol.for('nodejs.webstream.isClosedPromise'));
      Reflect.deleteProperty(Ctor.prototype, Symbol.for('nodejs.webstream.controllerErrorFunction'));
    }
    ${controls}\nawait dictionaryRepresentation(() => new Function(${JSON.stringify(initialize)})(), types.isProxy);`;
  const result = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});
function conversions({ controls, initialize }: { controls: string; initialize: string }) {
  return new Function(`${controls}\n${initialize ? `new Function(${JSON.stringify(initialize)})();` : ""}\nreturn dictionaryConversions(${!initialize});`)();
}
function representation({ controls, initialize }: { controls: string; initialize: string }) {
  return new Function(`${controls}\nreturn dictionaryRepresentation(() => new Function(${JSON.stringify(initialize)})());`)();
}
async function browserDictionaryControl(engine: typeof webkit | typeof chromium) {
  const browser = await engine.launch({ headless: true });
  try {
    let page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const native = await page.evaluate(conversions, { controls, initialize: "" });
    await page.close();
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    expect(await page.evaluate(conversions, { controls, initialize })).toEqual(native);
    await page.close();
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(representation, { controls, initialize });
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}
for (const engine of [webkit, chromium]) {
  test(`${engine.name()} dictionary shape and native conversion parity`, () => browserDictionaryControl(engine), 30000);
}
