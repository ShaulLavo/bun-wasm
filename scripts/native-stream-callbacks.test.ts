import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium, webkit } from "playwright";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const emit = (file: string) => transpiler.transformSync(readFileSync(new URL(file, import.meta.url), "utf8"));
const direct = emit("../web/src/native-direct-stream.ts").replace("export function", "function");
const bridge = emit("../web/src/native-stream-state.ts").replace(/^import .*;$/m, "").replace("export function", "function");
const controls = transpiler.transformSync(readFileSync(new URL("../web/tests/native-stream-callback-controls.ts", import.meta.url), "utf8")).replace("export async function", "async function");
const initialize = `${direct}\n${bridge}\nreturn installNativeStreamState();`;

for (const syncOnly of [true, false]) {
  test(`native callback ${syncOnly ? "synchronous returns" : "asynchronous ordering and errors"}`, () => {
    const code = `for (const Ctor of [ReadableStream, WritableStream]) {
      Reflect.deleteProperty(Ctor.prototype, Symbol.for("nodejs.webstream.isClosedPromise"));
      Reflect.deleteProperty(Ctor.prototype, Symbol.for("nodejs.webstream.controllerErrorFunction"));
    }
    ${controls}\nconst rows = await checkNativeStreamCallbacks(() => new Function(${JSON.stringify(initialize)})(), ${syncOnly});
    console.log(JSON.stringify(rows));`;
    const result = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toHaveLength(11);
  });
}

function evaluateCallbacks({ initialize, controls, syncOnly }: { initialize: string; controls: string; syncOnly: boolean }) {
  const check = new Function(`${controls}\nreturn checkNativeStreamCallbacks;`)();
  const install = new Function(initialize);
  return check(install, syncOnly);
}

for (const engine of [webkit, chromium]) {
  test(`${engine.name()} native callback returns, ordering and errors`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const syncOnly of [true, false]) {
        await page.goto("about:blank");
        const rows = await page.evaluate(evaluateCallbacks, { initialize, controls, syncOnly });
        expect(rows).toHaveLength(11);
      }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 30000);
}
