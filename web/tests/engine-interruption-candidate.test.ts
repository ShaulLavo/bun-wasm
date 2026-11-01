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
const dependencies = `import { programKind, programProfile } from ${JSON.stringify(new URL("../../src/engine-kind.ts", import.meta.url).href)};\nimport { prepareProgram } from ${JSON.stringify(new URL("../../src/assets.ts", import.meta.url).href)};\nconst truth = (value, message) => { if (!value) throw new Error(message); };\n`;
const { loadCandidate }: { loadCandidate(engine: Engine, name: string): Promise<{ module: WebAssembly.Module; hash: string; artifacts: { engine: Engine; name: string; sha256: string; bytes: number }[] }> } = await import(`data:text/javascript;base64,${Buffer.from(dependencies + javascript + "\nexport { loadCandidate };").toString("base64")}`);

test("candidate artifact block prepares three engines from five files", async () => {
  const { core, side } = quickjsPair();
  const jscPair = quickjsPair("jsc");
  const single = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const files = new Map([["/bun.wasm", core], ["/quickjs.wasm", side], ["/bun-jsc.wasm", jscPair.core], ["/jsc-engine.wasm", jscPair.side], ["/bun-browser.wasm", single]]);
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
    expect(artifacts.map(file => file.name)).toEqual(["bun.wasm", "quickjs.wasm", "bun-jsc.wasm", "jsc-engine.wasm", "bun-browser.wasm"]);
    expect(artifacts.map(file => file.engine)).toEqual(["quickjs", "quickjs", "jsc", "jsc", "browser"]);
    expect(programLinkPlan(quickjs.module)?.libraries[0]?.source).toEqual(side);
    expect(programLinkPlan(jsc.module)?.libraries[0]?.source).toEqual(jscPair.side);
    expect(programLinkPlan(browser.module)).toBeUndefined();
    files.delete("/jsc-engine.wasm");
    await expect(loadCandidate("jsc", "bun-jsc.wasm")).rejects.toThrow("jsc-engine.wasm: HTTP 404");
    files.delete("/quickjs.wasm");
    await expect(loadCandidate("quickjs", "bun.wasm")).rejects.toThrow("quickjs.wasm: HTTP 404");
  } finally { globalThis.fetch = original; }
});

test("candidate loader uses asynchronous compilation for every engine", async () => {
  const quickjs = quickjsPair(), jsc = quickjsPair("jsc");
  const files = new Map([
    ["/bun.wasm", quickjs.core], ["/quickjs.wasm", quickjs.side],
    ["/bun-jsc.wasm", jsc.core], ["/jsc-engine.wasm", jsc.side],
    ["/bun-browser.wasm", new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])],
  ]);
  const originalFetch = globalThis.fetch, Module = WebAssembly.Module;
  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: Parameters<typeof fetch>[0]) => {
      const bytes = files.get(String(input));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    } });
    WebAssembly.Module = new Proxy(Module, { construct() { throw new Error("synchronous candidate compilation"); } });
    for (const [engine, name] of [["quickjs", "bun.wasm"], ["jsc", "bun-jsc.wasm"], ["browser", "bun-browser.wasm"]] as const) {
      const loaded = await loadCandidate(engine, name);
      expect(loaded.module).toBeInstanceOf(Module);
      expect(loaded.artifacts[0]?.engine).toBe(engine);
    }
  } finally { globalThis.fetch = originalFetch; WebAssembly.Module = Module; }
});
