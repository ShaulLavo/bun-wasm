import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../src/buffer-transfer.ts";
import { ContentModules } from "../src/content-modules.ts";
import { SLOT_NAMES } from "../src/net/trampoline.ts";
import { createScriptEvaluation } from "../src/script-evaluation.ts";

const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");

// kit -> a -> b -> a: the back edge gives `a` a named URL whose source the store writes.
const graph: Record<string, string[]> = { kit: ["a"], a: ["b"], b: ["a"] };
const loaded = "data:text/javascript,export default 0";

function esm(key: string) {
  const imports = graph[key]!;
  const code = imports.map(() => `import "${"x".repeat(8)}";`).join("") + `export default ${JSON.stringify(key)};`;
  const step = `import "${"x".repeat(8)}";`.length;
  return { format: "esm", code, imports: imports.map((dependency, index) => ({ kind: "static", key: dependency, start: index * step + 7, end: index * step + 17 })) };
}

type Write = { url: string; settle(error?: Error): void; settled: boolean };

function holdWrite(url: string, writes: Write[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const write: Write = { url, settled: false, settle(error) { write.settled = true; if (error) reject(error); else resolve(); } };
    writes.push(write);
  });
}

/** An EngineHost whose named store holds every write until the test settles it. */
function host(moduleUrls: "blob" | "data") {
  const writes: Write[] = [];
  const imported: { url: string; pending: number }[] = [];
  const modules = {
    url: (key: string) => `memory:/m/${key}`,
    put: (url: string) => holdWrite(url, writes),
  };
  const context = createContext({ TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, isWasmMemoryBuffer, transferArrayBuffers, createScriptEvaluation, SLOT_NAMES, ContentModules, memoryViews: () => ({}) });
  const EngineHost = runInContext(source + "\nEngineHost;", context, {
    // The native module loader: records which writes were still pending when import() started.
    importModuleDynamically: ((url: string) => {
      imported.push({ url, pending: writes.filter(write => !write.settled).length });
      return import(loaded);
    }) as never,
  });
  const engine = new EngineHost({ instance: { exports: {} }, moduleUrls, modules }, () => {});
  engine.native = { hostModuleSource: esm };
  return { engine, writes, imported };
}

const settled = (promise: Promise<unknown>) => promise.then(() => "resolved", (error: Error) => error.message);
const turns = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

for (const mode of ["blob", "data"] as const) {
  test(`${mode}: an overlapping import waits for the module write another import is already awaiting`, async () => {
    const { engine, writes, imported } = host(mode);
    const first = settled(engine.importReady("kit"));
    const second = settled(engine.importReady("kit"));
    await turns();
    expect(writes.length).toBeGreaterThan(0);
    expect(imported).toEqual([]);
    for (const write of writes) write.settle();
    expect(await Promise.all([first, second])).toEqual(["resolved", "resolved"]);
    expect(imported.map(entry => entry.pending)).toEqual([0, 0]);
  });

  test(`${mode}: a failed module write rejects every import that was waiting for it`, async () => {
    const { engine, writes, imported } = host(mode);
    const first = settled(engine.importReady("kit"));
    const second = settled(engine.importReady("kit"));
    await turns();
    for (const write of writes) write.settle(new Error("cache full"));
    expect(await Promise.all([first, second])).toEqual(["cache full", "cache full"]);
    expect(imported).toEqual([]);
  });

  test(`${mode}: settled writes are released, so a later import does not wait or rethrow`, async () => {
    const { engine, writes, imported } = host(mode);
    const first = settled(engine.importReady("kit"));
    await turns();
    for (const write of writes) write.settle(new Error("cache full"));
    expect(await first).toBe("cache full");
    expect(await settled(engine.importReady("kit"))).toBe("resolved");
    expect(imported).toHaveLength(1);
  });
}
