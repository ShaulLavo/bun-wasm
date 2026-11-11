import { prepareProgram } from "../../src/assets.ts";
import { beginMemorySnapshot, endMemorySnapshot, recordMemorySnapshot } from "../../web/src/memory-telemetry.ts";
import { browserTrapSource } from "./browser-call-trap.ts";

async function runControl(): Promise<void> {
  const imported = new URL(location.href).searchParams.get("memory") === "imported";
  const module = await prepareProgram({ kind: "single", core: browserTrapSource(imported) });
  const id = "browser-trap-control";
  const transport = beginMemorySnapshot("browser", id, id, module);
  if (!transport) throw new Error("Control requires cross-origin isolation");
  const worker = new Worker("/worker.js", { type: "module" });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = event => {
        if (recordMemorySnapshot(event.data)) return;
        Reflect.set(globalThis, "__browserTrapControl", event.data);
        resolve();
      };
      worker.postMessage({ module, transport, imported });
    });
  } finally {
    worker.terminate();
    endMemorySnapshot(id);
  }
}

// Only the matrix harness's shell and terminal contract; no framework or guest build.
Reflect.set(globalThis, "playground", {
  profile: "split",
  shell: { running: false, lastExit: 1, input() {}, async submit() { await runControl(); throw new Error("real Browser core trap control"); } },
  previews: { serves: () => false },
  term: { write(_text: string, done: () => void) { done(); }, buffer: { active: { length: 0 } } },
});
Reflect.set(globalThis, "__browserTrapControlReady", true);
