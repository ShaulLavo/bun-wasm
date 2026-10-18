import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join, resolve } from "node:path";
import { createNodeProcess } from "../scripts/node-process.ts";
import { createWorkerProcessTransport, type WorkerProcessMessage } from "waffle/proc/worker-client";

test("Node WASI translates descriptors across preopens, controls, renumber, churn and transfer failure", () => {
  const scratch = mkdtempSync(join(process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir(), "bun-wasm-node-fds-"));
  try {
    const result = spawnSync("node", ["--no-warnings", new URL("./fixtures/node-descriptors.ts", import.meta.url).pathname, scratch], {
      cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Node descriptor translation, dynamic controls, churn, renumber, isolation and shared BADF checks passed\n");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a Node child reads relocated controls once and deletes their environment metadata", () => {
  const root = createWorkerProcessTransport();
  const messages: WorkerProcessMessage[] = [];
  const parent = createNodeProcess({ transport: root, postMessage: message => messages.push(message), finish(): never { throw new Error("unexpected exit"); } });
  let child: ReturnType<typeof createNodeProcess> | undefined;
  try {
    const [input, inputWriter] = parent.client.createPipe(), [outputReader, output] = parent.client.createPipe();
    const inputFd = parent.descriptors.open(input, 2n, 0n), outputFd = parent.descriptors.open(output, 64n, 0n);
    parent.descriptors.open(inputWriter, 64n, 0n); parent.descriptors.open(outputReader, 2n, 0n);
    const env = {
      BUNWASM_WORKER_INIT: JSON.stringify({ route: [1], envGroup: "worker", argv: ["bun"], execArgv: [], graph: {} }),
      BUNWASM_WORKER_CONTROL: JSON.stringify({ input: inputFd, output: outputFd }),
    };
    // These control binding numbers may be low; a child with six preopens must relocate them.
    const pid = parent.client.spawn(1, { executable: "bun", argv: [], cwd: "/", env, job: 0,
      fds: [{ child: inputFd, parent: inputFd }, { child: outputFd, parent: outputFd }] });
    expect(pid).toBeGreaterThan(1);
    const spawned = messages.find(message => message.operation === "spawn");
    if (spawned?.operation !== "spawn") throw new Error("spawn not published");
    child = createNodeProcess({ transport: spawned.transport, env: spawned.request.env, preopenCount: 6,
      registry: parent.registry, postMessage() {}, finish(): never { throw new Error("unexpected exit"); } });
    expect(JSON.parse(child.env.BUNWASM_WORKER_CONTROL!)).toEqual({ input: 9, output: 10 });
    const stop = new Error("control opened"), channels: number[][] = [];
    const source = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${readFileSync(
      new URL("../../crates/bunwasm-runtime/src/js/worker_threads.ts", import.meta.url), "utf8")}`);
    const factory = runInNewContext(source, { EventTarget, Event, MessageEvent, DOMException, URL, structuredClone });
    const process = { env: child.env, execArgv: [], execPath: "bun", cwd: () => "/" };
    const modules: Record<string, unknown> = {
      process, events: EventEmitter, structured_clone: { structuredClone }, net: {},
      worker_codec: { create: () => ({ prepare: () => ({ graph: {}, commit() {} }) }) },
      worker_channel: { open(input: number, output: number) { channels.push([input, output]); throw stop; } },
    };
    const implementation = factory({ native: {}, realTimers: { setImmediate() {} }, addIoWaiter() {},
      require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    });
    expect(() => implementation.initialize()).toThrow(stop);
    expect(channels).toEqual([[9, 10]]);
    expect(process.env.BUNWASM_WORKER_CONTROL).toBeUndefined();
    expect(process.env.BUNWASM_WORKER_INIT).toBeUndefined();
    implementation.initialize();
    expect(channels).toEqual([[9, 10]]);
  } finally { child?.dispose(); parent.dispose(); }
});
