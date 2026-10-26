import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";
import { programLinkPlan } from "../../src/assets";
import type { Engine } from "../src/bun-executor";

const source = await readFile(new URL("./engine-interruption-main.ts", import.meta.url), "utf8");
const begin = source.indexOf("async function loadCandidate(");
const end = source.indexOf("\nvoid (async () =>", begin);
expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(begin, end));
const dependencies = `import { prepareQuickjsProgram } from ${JSON.stringify(new URL("../../src/assets.ts", import.meta.url).href)};\nconst truth = (value, message) => { if (!value) throw new Error(message); };\n`;
const { loadCandidate }: { loadCandidate(engine: Engine, name: string): Promise<{ module: WebAssembly.Module; hash: string; artifacts: { engine: Engine; name: string; sha256: string; bytes: number }[] }> } = await import(`data:text/javascript;base64,${Buffer.from(dependencies + javascript + "\nexport { loadCandidate };").toString("base64")}`);

test("candidate artifact block prepares three engines from four files", async () => {
  const { core, side } = quickjsPair();
  const single = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const files = new Map([["/bun.wasm", core], ["/quickjs.wasm", side], ["/bun-jsc.wasm", single], ["/bun-browser.wasm", single]]);
  const original = globalThis.fetch;
  const requests: string[] = [];
  try {
    const fetchCandidate = async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input));
      const bytes = files.get(String(input));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchCandidate });
    const quickjs = await loadCandidate("quickjs", "bun.wasm");
    const jsc = await loadCandidate("jsc", "bun-jsc.wasm");
    const browser = await loadCandidate("browser", "bun-browser.wasm");
    const artifacts = quickjs.artifacts.concat(jsc.artifacts, browser.artifacts);
    expect(requests).toEqual(Array.from(files.keys()));
    expect(artifacts.map(file => file.name)).toEqual(["bun.wasm", "quickjs.wasm", "bun-jsc.wasm", "bun-browser.wasm"]);
    expect(artifacts.map(file => file.engine)).toEqual(["quickjs", "quickjs", "jsc", "browser"]);
    expect(programLinkPlan(quickjs.module)?.libraries[0]?.source).toEqual(side);
    expect(programLinkPlan(jsc.module)).toBeUndefined();
    expect(programLinkPlan(browser.module)).toBeUndefined();
    files.delete("/quickjs.wasm");
    await expect(loadCandidate("quickjs", "bun.wasm")).rejects.toThrow("quickjs.wasm: HTTP 404");
  } finally { globalThis.fetch = original; }
});
