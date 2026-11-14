import { expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { DescriptorTable } from "waffle/core/descriptors";
import { captureProcessObserver } from "waffle/proc/observation";
import { NodeProcessBroker } from "../scripts/node-spawn.ts";

class OwnedWorker extends Worker {
  stops = 0;
  constructor() { super("setInterval(() => {}, 1000)", { eval: true }); }
  override terminate(): Promise<number> { this.stops++; return super.terminate(); }
}

test("retired Node image callbacks and native return cannot affect its same-PID successor", async () => {
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const broker = new NodeProcessBroker({ module, launch() { throw new Error("unexpected launch"); } });
  const old = new OwnedWorker();
  const successor = new OwnedWorker();
  const nativeOldStop = old.terminate.bind(old);
  const nativeSuccessorStop = successor.terminate.bind(successor);
  const handle = spyOn(broker.broker, "handle").mockResolvedValue(undefined);
  const record = broker.supervisor.get(broker.root.pid)!;
  const original = record.image;
  try {
    broker.attach(old, broker.root);
    const observer = captureProcessObserver(broker.root);
    record.image = { ...original, generation: original.generation + 1, descriptors: new DescriptorTable() };
    original.phase = "retired";
    expect(() => broker.attach(successor, broker.root)).toThrow("missing process image");
    broker.attach(successor, { ...broker.root, generation: record.image.generation });
    old.emit("message", { type: "runtime-proc" });
    old.emit("error", new Error("old image failed"));
    old.emit("exit", 99);
    await old.terminate();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(handle).not.toHaveBeenCalled();
    expect(record.result).toBeNull();
    expect(observer.read()).toEqual({ kind: "pending" });
    expect(successor.stops).toBe(0);
    await broker.dispose();
    expect(successor.stops).toBe(1);
    expect(observer.read().kind).toBe("terminated");
  } finally {
    handle.mockRestore();
    await broker.dispose();
    await Promise.allSettled([nativeOldStop(), nativeSuccessorStop()]);
    original.descriptors.dispose();
  }
});
