import { FilesystemService } from "waffle/fs/service";
import { MemoryBackend } from "waffle/fs/backend";
import { createFilesystemConnection, createFilesystemIdentity } from "waffle/fs/protocol";
import { createNotificationBridge } from "waffle/browser/notification-relay";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { PipeController } from "waffle/proc/pipes";
import { createRing } from "waffle/browser/net/ring";

async function cohort(combined: boolean, count: number, fail: boolean, duration: number) {
  const service = new FilesystemService(new MemoryBackend());
  const identity = createFilesystemIdentity();
  const transport = createWorkerProcessTransport({ capacity: 4 }), wake = workerProcessState(transport).wake;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const owned: (() => unknown)[] = [];
  const ready: Promise<void>[] = [], results: Promise<unknown>[] = [];
  const noisy = new PipeController({ capacity: 8, wake, relay: "manual" });
  const reader = noisy.retain(1, "read"), writer = noisy.retain(2, "write");
  let publications = 0;
  const cleanup = async () => {
    for (const close of owned.reverse()) await close();
    reader.close(); writer.close(); noisy.dispose(); await service.shutdown();
  };
  try {
    for (let index = 0; index < count; index++) add(index);
    await Promise.all(ready);
    return { async run(noise: boolean) {
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        if (noise) timer = setInterval(() => { const byte = new Uint8Array(1); writer.tryWrite([byte]); reader.tryRead([byte]); publications++; }, 0);
        Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
        return { results: await Promise.all(results), publications };
      } finally { clearInterval(timer); }
    }, cleanup };
  } catch (error) { await cleanup(); throw error; }

  function add(index: number) {
    const pair = createFilesystemConnection(identity); service.connect(pair.server);
    const bridge = createNotificationBridge(new URL("./notification-worker.js", location.href).href);
    owned.push(() => bridge.dispose());
    const worker = new Worker(new URL("./mixed-resource-worker.js", location.href), { type: "module" });
    owned.push(() => worker.terminate());
    const pipe = new PipeController({ capacity: 8, wake, relay: "manual" }), input = pipe.retain(1, "read"), output = pipe.retain(2, "write");
    owned.push(() => { input.close(); output.close(); pipe.dispose(); });
    const started = Promise.withResolvers<void>(), done = Promise.withResolvers<unknown>();
    ready.push(started.promise); results.push(done.promise);
    worker.onerror = event => { started.reject(Error(event.message)); done.reject(Error(event.message)); };
    worker.onmessage = ({ data }) => { if (data.ready) started.resolve(); else done.resolve(data); };
    worker.postMessage({ filesystem: pair.client, notifications: bridge.connection, ring: createRing(), process: transport, pipe: input.handle(), gate,
      combined, networkOnly: index === 0, fail, duration }, [pair.client.port, bridge.connection.port]);
  }
}

let current: Awaited<ReturnType<typeof cohort>> | undefined;
Object.assign(globalThis, {
  async start(combined: boolean, count: number, fail = false, duration = 200) { current = await cohort(combined, count, fail, duration); },
  run: (noise: boolean) => current!.run(noise),
  cleanup: async () => { await current?.cleanup(); current = undefined; },
});
