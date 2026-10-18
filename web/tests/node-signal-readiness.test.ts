import { controlLoad, controlStore } from "waffle/proc/control";
import { expect, test } from "bun:test";
import { Wasi } from "waffle/core/wasi";
import { MemFS } from "waffle/fs/memory";
import { createSignalState, setSignalDisposition, takeSignal } from "waffle/proc/signals";
import { createNodeSignalController } from "../scripts/node-signals";

test("Node executor readiness ignores stale hints and expires a WASI clock normally", () => {
  const controller = createNodeSignalController();
  const interrupt = controller.buffers.interrupt instanceof SharedArrayBuffer ? new Int32Array(controller.buffers.interrupt) : controller.buffers.interrupt;
  controlStore(interrupt, 0, 15);
  expect(controller.pending()).toBe(false);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wasi = new Wasi({ fs: new MemFS(), args: [], env: {}, preopens: {}, interrupt,
    interruptPending: () => controller.pending(), stdout() {}, stderr() {},
    sleep() { throw new Error("an expired clock must not sleep"); },
    wait() { throw new Error("an expired clock must not wait"); } });
  const imports = (wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }).functions();
  try {
    wasi.start({ exports: { memory, _start() {} } } as unknown as WebAssembly.Instance);
    const view = new DataView(memory.buffer);
    view.setUint8(8, 0); view.setUint32(16, 1, true); view.setBigUint64(24, 0n, true);
    expect(imports.poll_oneoff!(0, 128, 1, 256)).toBe(0);
    expect(view.getUint32(256, true)).toBe(1);
    expect(controlLoad(interrupt, 0)).toBe(15);
    expect(controller.pending()).toBe(false);
  } finally { wasi.descriptors.dispose(); }
});

test("Node readiness observes handled and fatal delivery without consuming it", () => {
  const controller = createNodeSignalController();
  const state = createSignalState(controller.buffers.signalState);
  const interrupt = controller.buffers.interrupt instanceof SharedArrayBuffer ? new Int32Array(controller.buffers.interrupt) : controller.buffers.interrupt;
  setSignalDisposition(state, 2, 2);
  controller.request(2);
  expect(controller.pending()).toBe(true);
  expect(controller.pending()).toBe(true);
  expect(takeSignal(state, interrupt)).toBe(2);
  expect(controller.pending()).toBe(false);
  controller.request(15);
  expect(controller.pending()).toBe(true);
  expect(controller.selected()).toEqual({ kind: "signaled", code: 15, status: 143 });
  expect(controller.pending()).toBe(true);
});
