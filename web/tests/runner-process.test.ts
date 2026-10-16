import { expect, test } from "bun:test";
import { startRun } from "../src/runner";
import type { SharedFilesystem } from "../src/shared-fs";
import type { RunRequest } from "../src/worker";

test.each([{ signal: undefined, code: 130 }, { signal: 9 as const, code: 137 }])("non-isolated root commands start without SharedArrayBuffer and stop with $code", async ({ signal, code }) => {
  const originalWorker = globalThis.Worker;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const originalShared = globalThis.SharedArrayBuffer;
  let sent: RunRequest | undefined;
  let terminated = 0;
  let revoked = 0;
  const channel = new MessageChannel();
  let release!: () => void;
  const section = new Promise<void>(resolve => { release = resolve; });
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://localhost/") });
    Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: false });
    globalThis.SharedArrayBuffer = undefined as unknown as typeof SharedArrayBuffer;
    globalThis.Worker = class {
      postMessage(request: RunRequest) { sent = request; }
      terminate() { terminated++; }
    } as unknown as typeof Worker;
    const filesystem = { fork: () => ({ port: channel.port1 }), async quiesce() { revoked++; await section; } } as unknown as SharedFilesystem;
    const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const run = startRun({ engine: "browser", module, args: ["-e", "0"], env: {}, filesystem, moduleScope: false }, { stdout() {}, stderr() {} });
    expect(sent?.interrupt).toBeUndefined();
    expect(sent?.net).toBeNull();
    run.kill(signal);
    expect(await run.done).toEqual({ code });
    expect(terminated).toBe(0);
    expect(revoked).toBe(1);
    release();
    await section;
    await Promise.resolve();
    expect(terminated).toBe(1);
  } finally {
    release();
    globalThis.Worker = originalWorker;
    globalThis.SharedArrayBuffer = originalShared;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else Reflect.deleteProperty(globalThis, "location");
    if (originalIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", originalIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
    channel.port1.close(); channel.port2.close();
  }
});
