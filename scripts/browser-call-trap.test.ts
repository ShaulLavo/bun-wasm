import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { memoryViews } from "waffle/core/memory-views";
import { prepareProgram } from "../src/assets.ts";
import { programCoreMemoryLimits, recordProgramMemory } from "../src/program-memory.ts";
import type { EngineHostOptions } from "../web/src/engine-host.js";
import { beginMemorySnapshot, endMemorySnapshot, publishBrowserCallTrap, recordMemorySnapshot, reportWasmCallTrap, retainedMemorySnapshots } from "../web/src/memory-telemetry.ts";
import { browserTrapSource } from "./fixtures/browser-call-trap.ts";
import { browserTrapLog } from "./goals-matrix/browser-memory.ts";
import { execute } from "./goals-matrix/execute.ts";
import { frameworks } from "./goals-matrix/catalog.ts";
import { withPlayground } from "./goals-matrix/test-fixture.ts";

// Exercise the production codec and call wrapper without starting an engine realm
// in the shared unit-test process. The full host runs in disposable Browser workers.
const host = readFileSync(new URL("../web/src/engine-host.js", import.meta.url), "utf8");
const start = host.indexOf("const utf8 = ");
const end = host.indexOf("// Thrown to unwind after process.exit", start);
if (start < 0 || end <= start) throw Error("Missing production native-call wrapper");
const factory: unknown = runInNewContext(`${host.slice(start, end)}\nwasmCaller`, {
  NativeTextEncoder: TextEncoder, NativeTextDecoder: TextDecoder, memoryViews, reportWasmCallTrap,
  WebAssembly, Uint8Array, ArrayBuffer, DataView, Error, TypeError, RangeError, SyntaxError,
});
function nativeCall(instance: WebAssembly.Instance, observer: NonNullable<EngineHostOptions["onWasmCallTrap"]>): () => unknown {
  if (typeof factory !== "function") throw Error("Missing native-call factory");
  const caller: unknown = factory(instance.exports, observer);
  if (!caller || typeof caller !== "object" || !("call" in caller) || typeof caller.call !== "function") throw Error("Missing native-call wrapper");
  const call = caller.call;
  return () => Reflect.apply(call, caller, [0, []]);
}

test("real native-call trap preserves identity even when its observer throws", async () => {
  const module = await prepareProgram({ kind: "single", core: browserTrapSource() });
  const instance = await WebAssembly.instantiate(module);
  let observed: unknown;
  const call = nativeCall(instance, error => { observed = error; throw Error("observer"); });
  try {
    call();
    throw Error("Expected a real Wasm trap");
  } catch (error) {
    expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(error).toBe(observed);
  }
  expect(instance.exports.memory).toBeInstanceOf(WebAssembly.Memory);
});

for (const imported of [false, true]) test(`${imported ? "imported" : "defined"} memory retains distinct declared and factory limits through cleanup`, async () => {
  const source = browserTrapSource(imported);
  const module = await WebAssembly.compile(source);
  recordProgramMemory(module, source);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  const id = crypto.randomUUID();
  const transport = beginMemorySnapshot("browser", id, id, module);
  if (!transport) throw Error("Missing diagnostic transport");
  try {
    const call = nativeCall(instance, (_error, index) => publishBrowserCallTrap(instance, index, transport, recordMemorySnapshot));
    expect(call).toThrow(WebAssembly.RuntimeError);
  } finally { endMemorySnapshot(id); }
  const snapshot = retainedMemorySnapshots().find(value => value.id === id);
  expect(snapshot).toMatchObject({ terminal: true, wasmCapacityBytes: 2 * 65536,
    memoryLimitBytes: imported ? null : 8 * 65536,
    failedAllocation: null, engineCounters: { browserCallTrapIndex: 0, browserCallTrapCapacityBytes: 2 * 65536,
      browserCoreDeclaredMaximumBytes: 8 * 65536, browserCoreFactoryMaximumBytes: imported ? null : 8 * 65536 } });
});

test("missing compiled maximum and unrecorded modules remain unknown", async () => {
  const source = browserTrapSource(false, null);
  const module = await WebAssembly.compile(source);
  recordProgramMemory(module, source);
  expect(programCoreMemoryLimits(module)).toEqual({ declaredMaximumBytes: null, factoryMaximumBytes: null });
  expect(programCoreMemoryLimits(await WebAssembly.compile(browserTrapSource()))).toEqual({ declaredMaximumBytes: null, factoryMaximumBytes: null });
});

test("unavailable collection is explicit and does not replace the matrix error", async () => {
  const transport = { async useHost() {}, async evaluate<T>(expression: string): Promise<T> { return runInNewContext(expression); } };
  expect(await browserTrapLog(transport, "browser")).toContain("diagnostic hook is unavailable");
  expect(await browserTrapLog({ ...transport, async useHost() { throw Error("closed host"); } }, "browser")).toContain("host observation failed");
  expect(await browserTrapLog(transport, "jsc")).toBe("");
});

test.each([false, true])("a stalled diagnostic keeps the original error and log with owned cleanup = %s", async owned => {
  const framework = frameworks[0];
  if (!framework) throw Error("Missing matrix framework");
  await withPlayground(framework, 0, async transport => {
    const evaluate = transport.evaluate;
    await evaluate('playground.shell.submit = async () => { throw Error("original command failure"); }');
    await evaluate('playground.term.buffer.active = { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => "kept terminal" }) };');
    let terminalReads = 0;
    const diagnostic = Promise.withResolvers<string>();
    transport.evaluate = <T>(expression: string): Promise<T> => {
      if (expression.includes("transcript") && ++terminalReads === 2) return Promise.reject(Error("failure-time terminal unavailable"));
      if (expression.includes("browserTrapFacts")) return diagnostic.promise.then(() => evaluate<T>(JSON.stringify("late diagnostic")));
      return evaluate<T>(expression);
    };
    let closed = false;
    let saved = "";
    let saves = 0;
    const close = transport.close;
    transport.close = async () => { closed = true; await close(); };
    if (owned) transport.cleanup = async () => { closed = true; return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    const result = await execute({ framework, box: { framework: framework.id, browser: "chrome", engine: "browser" }, url: "http://fixture/?engine=browser", timeoutMs: 1000,
      async createTransport() { return transport; }, async saveLog(text) { saved = text; saves++; },
    });
    expect(result).toMatchObject({ status: "fail", phase: "install" });
    if (result.status !== "fail") throw Error("Expected original command failure");
    expect(result.error).toContain("original command failure");
    expect(saved).toContain("kept terminal");
    expect(saved).toContain("Browser core trap memory snapshots unavailable within the final observation budget");
    expect(closed).toBe(true);
    expect(result.attempts[0]?.phases.find(value => value.phase === "cleanup")).toMatchObject({ status: "pass", timeoutMs: 20_000 });
    diagnostic.resolve("late diagnostic");
    await Bun.sleep(0);
    expect(saves).toBe(1);
    expect(saved).not.toContain("late diagnostic");
  });
}, 10_000);
