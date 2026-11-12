import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FilesystemService } from "waffle/fs/service";
import { MemoryBackend } from "waffle/fs/backend";
import { createFilesystemConnection } from "waffle/fs/protocol";
import { createNotificationBridge } from "waffle/browser/notification-relay";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { PipeController } from "waffle/proc/pipes";
import { createRing } from "waffle/browser/net/ring";
import type { MixedRequest } from "./fixtures/mixed-worker";

async function exercise(mode: MixedRequest["mode"], transport: MixedRequest["transport"]) {
  const service = new FilesystemService(new MemoryBackend()), pair = createFilesystemConnection();
  service.connect(pair.server);
  const bridge = createNotificationBridge(new URL("../src/notification-worker.ts", import.meta.url).href);
  const worker = new Worker(new URL("./fixtures/mixed-worker.ts", import.meta.url).href);
  const process = createWorkerProcessTransport({ capacity: 4 }), wake = workerProcessState(process).wake;
  const pipe = new PipeController({ capacity: 8, ...(mode === "uncovered" ? {} : { wake }), relay: "manual" });
  const other = new PipeController({ capacity: 8, wake, relay: "manual" });
  const reader = pipe.retain(1, "read"), writer = pipe.retain(2, "write");
  const otherReader = other.retain(1, "read"), otherWriter = other.retain(2, "write");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let bound: ReturnType<typeof setTimeout> | undefined, publications = 0;
  try {
    const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/net.js", import.meta.url), "utf8").split("  // Run each waiter once;")[0]!;
    if (mode === "before") writer.tryWrite([new Uint8Array([81])]);
    return await new Promise<Record<string, number | boolean>>((resolve, reject) => {
      bound = setTimeout(() => reject(Error("mixed Worker fixture timeout")), 5000);
      worker.onerror = event => reject(Error(event.message));
      worker.onmessage = ({ data }) => {
        if (data.error) { reject(Error(data.error + "\n" + data.stack)); return; }
        if (data.done) { resolve({ ...data.done, publications }); return; }
        if (publications++) return;
        publish(mode);
      };
      worker.postMessage({ filesystem: pair.client, notifications: bridge.connection, ring: createRing(), process,
        pipe: reader.handle(), source, mode, transport, gate } satisfies MixedRequest, [pair.client.port, bridge.connection.port]);
    });
  } finally {
    clearTimeout(bound); await bridge.dispose(); await worker.terminate();
    reader.close(); writer.close(); otherReader.close(); otherWriter.close(); pipe.dispose(); other.dispose(); await service.shutdown();
  }

  function publish(selected: MixedRequest["mode"]) {
    if (selected === "noise" || selected === "network-noise") {
      const until = performance.now() + 180, byte = new Uint8Array(1);
      while (performance.now() < until) { otherWriter.tryWrite([byte]); otherReader.tryRead([byte]); publications++; }
      return;
    }
    if (selected === "close") { Atomics.store(bridge.connection.state, 1, 1); Atomics.add(bridge.connection.state, 0, 1); Atomics.notify(bridge.connection.state, 0); return; }
    Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
    writer.tryWrite([new Uint8Array([81])]);
  }
}

for (const transport of ["table", "imports"] as const) {
  for (const mode of ["selected", "before", "between", "noise", "network-noise", "close", "cancel", "uncovered"] as const) {
    test(`real Worker mixed wait: ${mode}, ${transport}`, async () => {
      const result = await exercise(mode, transport);
      expect(result.network).toBe(0);
      if (mode === "cancel") { expect(result.fatal).toBe(true); return; }
      if (mode === "noise" || mode === "network-noise") {
        expect(result.result).toBe(0); expect(result.read).toBe(-6); expect(result.publications).toBeGreaterThan(100);
        expect(result.elapsed).toBeGreaterThanOrEqual(110); expect(result.elapsed).toBeLessThan(500); return;
      }
      if (mode === "close") { expect(result.result).toBe(0); return; }
      expect(result.result).toBe(1); expect(result.read).toBe(1); expect(result.byte).toBe(81);
      if (mode === "uncovered") expect(result.uncovered).toBe(true);
    });
  }
}
