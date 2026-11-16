import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { sourcePorts, type SourcePort } from "./fixtures/shared-objects/source-runtime";

const cleanup = new Set<() => void>();
afterEach(() => { for (const close of cleanup) close(); cleanup.clear(); });
const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/events.ts", import.meta.url), "utf8");
const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);

async function consume(wait: (port: SourcePort, name: string) => Promise<unknown[]>, port: SourcePort, received: unknown[]) {
  for (let index = 0; index < 3; index++) {
    received.push((await wait(port, "message"))[0]);
    await Promise.resolve();
    await Promise.resolve();
  }
}

function observeDrain(port: SourcePort, done: () => void) {
  port.on("message", value => {
    if (value === 3) setImmediate(done);
  });
}

test("selected messages wait for the complete async once continuation", async () => {
  const runtime = sourcePorts();
  cleanup.add(() => runtime.__fixtureShutdown());
  const { port1, port2 } = new runtime.MessageChannel();
  const events = runInNewContext(emitted)({});
  const received: unknown[] = [];
  try {
    const drained = new Promise<void>(resolve => observeDrain(port2, resolve));
    port1.postMessage(1);
    port1.postMessage(2);
    port1.postMessage(3);
    const consuming = consume(events.once, port2, received);
    await drained;
    expect(received).toEqual([1, 2, 3]);
    await consuming;
  } finally {
    port1.close(); port2.close();
    runtime.__fixtureShutdown();
  }
}, 30_000);
