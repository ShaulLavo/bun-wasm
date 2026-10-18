import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createNodeSignalController } from "../scripts/node-signals.ts";
import { setSignalDisposition, takeSignal, createSignalState } from "waffle/proc/signals";

for (const signal of [2, 15, 13]) {
  test(`Node root default ${signal} seals typed status before worker teardown`, () => {
    const parent = createNodeSignalController();
    const guest = createNodeSignalController(parent.buffers);
    expect(parent.request(signal).action).toBe("default");
    expect(guest.selected()).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
    expect(guest.finish(0)).toEqual(parent.finish(1));
    expect(parent.finish(0).status).toBe(128 + signal);
  });
  test(`Node root handled ${signal} retains the guest's ordinary exit`, () => {
    const parent = createNodeSignalController();
    const guest = createNodeSignalController(parent.buffers);
    const state = createSignalState(parent.buffers.signalState);
    setSignalDisposition(state, signal, 2);
    expect(parent.request(signal).action).toBe("handled");
    expect(parent.selected()).toBeNull();
    expect(takeSignal(state)).toBe(signal);
    expect(takeSignal(state)).toBe(0);
    expect(guest.finish(143)).toEqual({ kind: "exited", code: 143, status: 143 });
    expect(parent.finish(0).kind).toBe("exited");
  });
}

test("Node root ignored requests do not select a terminal outcome", () => {
  const controller = createNodeSignalController();
  const state = createSignalState(controller.buffers.signalState);
  setSignalDisposition(state, 15, 1);
  expect(controller.request(15).action).toBe("ignore");
  expect(controller.selected()).toBeNull();
  expect(takeSignal(state)).toBe(0);
});

test("Node guest typed self-default remains distinct from ordinary 143", () => {
  const controller = createNodeSignalController();
  expect(controller.finish(143, 15)).toEqual({ kind: "signaled", code: 15, status: 143 });
  expect(controller.finish(0).kind).toBe("signaled");
  const ordinary = createNodeSignalController();
  expect(ordinary.finish(143)).toEqual({ kind: "exited", code: 143, status: 143 });
  expect(ordinary.request(9).action).toBe("settled");
});

test("Node ordinary exits are normalized before becoming shared outcomes", () => {
  expect(createNodeSignalController().finish(-1)).toEqual({ kind: "exited", code: 255, status: 255 });
  expect(createNodeSignalController().finish(256)).toEqual({ kind: "exited", code: 0, status: 0 });
});

test("Node distinct handled requests survive a single wake hint", () => {
  const controller = createNodeSignalController();
  const state = createSignalState(controller.buffers.signalState);
  setSignalDisposition(state, 2, 2);
  setSignalDisposition(state, 15, 2);
  controller.request(15); controller.request(2); controller.request(2);
  expect(takeSignal(state)).toBe(2);
  expect(takeSignal(state)).toBe(15);
  expect(takeSignal(state)).toBe(0);
  expect(controller.selected()).toBeNull();
});

// Exercise the real ProcessABI guard in native Node workers, not extracted adapter text.
for (const mode of ["raise", "pending-removal", "checkpoint"]) test(`Node ${mode} cannot catch default and continue I/O or an endless loop`, () => {
  const controllerUrl = new URL("../scripts/node-signals.ts", import.meta.url).href;
  const hostUrl = new URL("../scripts/node-process.ts", import.meta.url).href;
  const workerSource = `
    import { parentPort, workerData } from "node:worker_threads";
    import { workerProcessState } from "waffle/proc/worker-client";
    import { createNodeSignalController } from ${JSON.stringify(controllerUrl)};
    import { createNodeProcess } from ${JSON.stringify(hostUrl)};
    const signals = createNodeSignalController(workerProcessState(workerData.transport).signals);
    const host = createNodeProcess({ transport: workerData.transport, postMessage() {},
      finish(code, signal) { const selected = signals.finish(code, signal); process.exit(selected.status); },
    });
    const instance = { exports: { memory: new WebAssembly.Memory({initial:1}) } };
    const wasi_snapshot_preview1 = { sock_send: () => 0, fd_read: () => 0, fd_write: () => 0, fd_close: () => 0 };
    const { proc } = host.install({wasi_snapshot_preview1}, () => instance);
    parentPort.postMessage("ready");
    try {
      ${mode === "raise" ? "proc.signal(15, 3);" : mode === "pending-removal"
        ? "proc.signal(15, 2); signals.request(15); proc.signal(15, 0);"
        : "signals.request(15); proc.signal(0, 0);"}
    } catch (error) { parentPort.postMessage("caught"); }
    parentPort.postMessage("forbidden I/O");
    for (;;) {}
  `;
  const driver = `
    import { Worker } from "node:worker_threads";
    import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
    import { createNodeSignalController } from ${JSON.stringify(controllerUrl)};
    const transport = createWorkerProcessTransport();
    const signals = createNodeSignalController(workerProcessState(transport).signals);
    const worker = new Worker(${JSON.stringify(workerSource)}, { eval: true, workerData: { transport } });
    const messages = [];
    worker.on("message", value => messages.push(value));
    let expired = false;
    const timer = setTimeout(() => { expired = true; void worker.terminate(); }, 2000);
    try {
      const status = await new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
      console.log(JSON.stringify({ status, expired, messages, outcome: signals.selected() }));
    } finally { clearTimeout(timer); await worker.terminate(); }
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", driver], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 4000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: 143, expired: false, messages: ["ready"],
    outcome: { kind: "signaled", code: 15, status: 143 },
  });
});
