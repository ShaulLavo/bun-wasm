import { parentPort, workerData } from "node:worker_threads";
import { parseProgramFiles, programKind } from "../../../src/engine-kind.ts";
import { prepareProgram, programLinkPlan } from "../../../src/assets.ts";
import { linkNodeProgram } from "../../scripts/node-linked.ts";

const data: unknown = workerData;
if (!data || typeof data !== "object" || !("files" in data) || !("module" in data)
  || !(data.module instanceof WebAssembly.Module) || !("env" in data)
  || !data.env || typeof data.env !== "object" || Array.isArray(data.env)
  || !Object.values(data.env).every(value => typeof value === "string")) {
  throw new TypeError("Invalid SpiderMonkey host fixture request");
}
const files = parseProgramFiles(data.files, bytes => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Fixture bytes required");
  return bytes;
});
if (files.kind !== "spidermonkey" || programKind(data.module) !== files.kind) throw new TypeError("Wrong selected fixture engine");
const prepared = await prepareProgram(files);
const source = programLinkPlan(prepared);
if (!source) throw new Error("Fixture link plan missing");
const linked = await linkNodeProgram(source, { runtime_proc: { signal: () => 0 } });
try {
  linked.initialize();
  const value = linked.entry.exports.value;
  if (typeof value !== "function") throw new Error("Fixture value export missing");
  parentPort?.postMessage({ tier: Reflect.get(data.env, "BUN_WASM_SPIDERMONKEY_TIER"), kind: programKind(data.module), value: value() });
} finally { linked.dispose(); }
