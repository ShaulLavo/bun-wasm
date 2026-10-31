import { expect, test } from "bun:test";
import { NetHost } from "waffle/browser/net/host";
import { AGAIN, ERROR, type NetRequest } from "waffle/browser/net/protocol";
import { createRing } from "waffle/browser/net/ring";

async function changed(read: () => Uint8Array | number, failed: () => Error | undefined) {
  for (let turn = 0; turn < 100; turn++) {
    const error = failed();
    if (error) throw error;
    const value = read();
    if (value !== AGAIN) return value;
    await Bun.sleep(1);
  }
  throw new Error("Network helper did not answer the immediate request");
}

test("CLI helper initializes its namespace before immediate requests and preserves fetch errors", async () => {
  const ring = createRing();
  const worker = new Worker(new URL("../scripts/net-helper.ts", import.meta.url).href);
  let workerError: Error | undefined;
  worker.onerror = event => { workerError = new Error(event.message); };
  const host = new NetHost(ring, (request, transfer = []) => worker.postMessage(request, transfer));
  try {
    worker.postMessage({ type: "init", ring });
    const reply = new Int32Array(new SharedArrayBuffer(12));
    worker.postMessage({ type: "tcp-connect", id: 1000, host: "localhost", port: 1, reply: reply.buffer } satisfies NetRequest);
    const first = host.fetch(JSON.stringify({ url: "data:text/plain,immediate" }));
    expect(await changed(() => host.fetchHead(first), () => workerError)).toBeInstanceOf(Uint8Array);
    expect(await changed(() => host.read(first, 100), () => workerError)).toEqual(new TextEncoder().encode("immediate"));
    expect(host.close(first)).toBe(0);
    expect(await changed(() => Atomics.load(reply, 0) ? Atomics.load(reply, 1) : AGAIN, () => workerError)).toBeLessThan(ERROR);
    const invalid = host.fetch(JSON.stringify({ url: "unsupported+test://invalid/" }));
    expect(await changed(() => host.fetchHead(invalid), () => workerError)).toBeLessThan(0);
    expect(host.error(invalid)).toContain("message");
    expect(host.close(invalid)).toBe(0);
    expect(workerError).toBeUndefined();
  } finally {
    host.dispose();
    await worker.terminate();
  }
});


for (const phase of ["startup", "gated dispatch", "ready dispatch"] as const) {
  test(`CLI helper reports ${phase} failure through its worker error channel`, async () => {
    const ring = createRing();
    const worker = new Worker(new URL("../scripts/net-helper.ts", import.meta.url).href);
    let failure: Error | undefined;
    worker.onerror = event => { failure = new Error(event.message); event.preventDefault(); };
    const host = new NetHost(ring, (request, transfer = []) => worker.postMessage(request, transfer));
    try {
      worker.postMessage({ type: "init", ring: phase === "startup" ? new SharedArrayBuffer(0) : ring });
      if (phase === "ready dispatch") {
        const first = host.fetch(JSON.stringify({ url: "data:text/plain,ready" }));
        expect(await changed(() => host.fetchHead(first), () => failure)).toBeInstanceOf(Uint8Array);
        host.close(first);
      }
      if (phase !== "startup") worker.postMessage({ type: "tcp-connect", id: 1000, host: "localhost", port: 1, reply: new SharedArrayBuffer(0) } satisfies NetRequest);
      await changed(() => failure ? 0 : AGAIN, () => undefined);
      expect(failure?.message).toMatch(/RangeError|length|offset|bounds/);
    } finally {
      host.dispose();
      await worker.terminate();
    }
  });
}
