import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectMemorySnapshots } from "./app-matrix/engine-memory-hook.ts";
import { emptyCounters } from "../web/src/memory-telemetry.ts";
import { actorSnapshot, failedBytes, verifyAllocation, verifyFailure, verifyChild, installActorObserver, selectActor } from "./verify-engine-memory-browser.ts";
import { maxMemoryBytes } from "./src/program-profile.ts";

const engine = "quickjs";
const actor = { authority: "host-worker-launch", id: "fixture", engine, path: "/home/user/memory-producer.ts" } as const;
const child = { ...actor, id: "child", path: "/home/user/memory-child.ts" };
const parent = { ...actor, id: "parent", path: "/home/user/memory-parent.ts" };
const failed = { bytes: failedBytes, category: "quickjs.arrayBuffer" };

test("fixture requests an allocation beyond the authoritative guest maximum", () => {
  expect(failedBytes).toBeGreaterThan(maxMemoryBytes());
});
function snapshot(id: string = actor.id, changes: Record<string, unknown> = {}) {
  return { ...emptyCounters, id, engine, time: 1, terminal: false, allocatorLiveBytes: 100,
    allocatorPeakBytes: 200, jsHeapBytes: 40, arrayBufferBytes: 1048576, engineCounters: { refreshSequence: 7 }, ...changes };
}
const frame = (...raw: unknown[]) => selectMemorySnapshots(raw, engine);
const allocation = () => frame(snapshot(actor.id, { allocatorLiveBytes: 101 }));
const failure = () => frame(snapshot(actor.id, { failedAllocation: failed }));
const terminal = () => frame(snapshot(actor.id, { failedAllocation: failed, terminal: true }));

test("proxy: actual hook unknown totals still allow checks of an explicitly bound raw actor", () => {
  const baseline = frame(snapshot());
  expect(baseline.attribution.kind).toBe("unknown");
  expect(baseline.allocatorLiveBytes).toBeNull();
  expect(failure().failureProcessId).toBeNull();
  verifyAllocation(baseline, baseline, allocation(), actor);
  verifyFailure(allocation(), failure(), terminal(), actor);
  expect(actorSnapshot(failure(), actor).failedAllocation).toEqual(failed);
});

test("proxy: actor selection ignores clocks, order and unrelated earlier/later failures", () => {
  const other = snapshot("other", { failedAllocation: failed, terminal: true, time: 999, commandSequence: 999 });
  verifyAllocation(frame(other, snapshot()), frame(snapshot(), other), frame(other, snapshot(actor.id, { allocatorLiveBytes: 101 })), actor);
  verifyFailure(allocation(), frame(other, snapshot(actor.id, { failedAllocation: failed })), frame(snapshot(actor.id, { failedAllocation: failed, terminal: true }), other), actor);
  expect(() => verifyFailure(allocation(), frame(other, snapshot()), terminal(), actor)).toThrow();
});

test("proxy: missing, duplicate, malformed and wrong-engine actor observations fail closed", () => {
  for (const raw of [[], [snapshot("other")], [snapshot(), snapshot()], [snapshot(), { id: actor.id }], [snapshot(actor.id, { engine: "jsc" })]]) {
    expect(() => actorSnapshot(frame(...raw), actor)).toThrow();
  }
});

test("proxy: every allocation and cached-read condition remains enforced for the selected actor", () => {
  const base = frame(snapshot());
  const unrelated = snapshot("other", { allocatorLiveBytes: 999999, jsHeapBytes: 999999 });
  expect(() => verifyAllocation(base, base, frame(unrelated, snapshot()), actor)).toThrow();
  expect(() => verifyAllocation(base, frame(unrelated, snapshot(actor.id, { allocatorLiveBytes: null })), allocation(), actor)).toThrow();
  expect(() => verifyAllocation(base, base, frame(unrelated, snapshot(actor.id, { allocatorLiveBytes: 101, jsHeapBytes: null })), actor)).toThrow();
  expect(() => verifyAllocation(base, frame(snapshot(actor.id, { allocatorLiveBytes: null })), allocation(), actor)).toThrow();
  for (const changes of [{ allocatorLiveBytes: null }, { allocatorLiveBytes: 100 }, { allocatorPeakBytes: null },
    { allocatorPeakBytes: 1 }, { jsHeapBytes: null, nativeRssBytes: 999999 }, { arrayBufferBytes: null }, { arrayBufferBytes: 1048575 }, { terminal: true }, { failedAllocation: failed }]) {
    expect(() => verifyAllocation(base, base, frame(snapshot(actor.id, changes)), actor)).toThrow();
  }
});

test("proxy: exact failure, cached sequence and terminal state cannot be supplied by another actor", () => {
  for (const changes of [{ failedAllocation: null }, { failedAllocation: { ...failed, bytes: 1 } },
    { failedAllocation: { ...failed, category: "jsc.typedArray" } }, { engineCounters: {} }, { engineCounters: { refreshSequence: null } },
    { engineCounters: { refreshSequence: 8 } }]) {
    expect(() => verifyFailure(allocation(), frame(snapshot(actor.id, { failedAllocation: failed, ...changes })), terminal(), actor)).toThrow();
  }
  expect(() => verifyFailure(allocation(), failure(), failure(), actor)).toThrow();
  expect(() => verifyFailure(allocation(), failure(), frame(snapshot(actor.id, { terminal: true })), actor)).toThrow();
  expect(() => verifyFailure(allocation(), failure(), frame(snapshot(actor.id, { terminal: true, failedAllocation: failed, engineCounters: { refreshSequence: 8 } })), actor)).toThrow();
});

test("proxy: JSC preserves unknown exact backing stores and Hermes is outside this gate", () => {
  const jscActor = { ...actor, engine: "jsc" } as const;
  const jsc = (changes = {}) => selectMemorySnapshots([snapshot(actor.id, { engine: "jsc", arrayBufferBytes: null, ...changes })], "jsc");
  verifyAllocation(jsc(), jsc(), jsc({ allocatorLiveBytes: 101 }), jscActor);
  verifyFailure(jsc(), jsc({ failedAllocation: { ...failed, category: "jsc.typedArray" } }), jsc({ terminal: true, failedAllocation: { ...failed, category: "jsc.typedArray" } }), jscActor);
  expect(() => verifyAllocation(jsc(), jsc(), jsc({ allocatorLiveBytes: 101, arrayBufferBytes: 1 }), jscActor)).toThrow();
  expect(() => selectActor([{ ...actor, engine: "hermes" }], actor)).toThrow();
});

function childFrames(changes = {}) {
  const live = frame(snapshot(parent.id), snapshot(child.id));
  const failure = frame(snapshot(parent.id), snapshot(child.id, { failedAllocation: failed, terminal: true, ...changes }));
  const terminal = frame(snapshot(parent.id, { terminal: true }), snapshot(child.id, { failedAllocation: failed, terminal: true }));
  return { live, failure, terminal };
}
test("proxy: retained child checks name both actors and ignore unrelated command failures", () => {
  const good = childFrames();
  verifyChild(good.live, good.failure, good.terminal, parent, child);
  verifyChild(frame(snapshot("old", { failedAllocation: failed, terminal: true }), snapshot(parent.id), snapshot(child.id)), good.failure, good.terminal, parent, child);
  expect(() => verifyChild(good.live, good.failure, good.terminal, parent, parent)).toThrow();
  for (const changes of [{ terminal: false }, { failedAllocation: null }, { engineCounters: { refreshSequence: 8 } }]) {
    expect(() => verifyChild(good.live, childFrames(changes).failure, good.terminal, parent, child)).toThrow();
  }
  expect(() => verifyChild(frame(snapshot(parent.id, { failedAllocation: failed }), snapshot(child.id)), good.failure, good.terminal, parent, child)).toThrow();
  expect(() => verifyChild(good.live, frame(snapshot(parent.id, { terminal: true }), snapshot(child.id, { failedAllocation: failed, terminal: true })), good.terminal, parent, child)).toThrow();
  expect(() => verifyChild(good.live, good.failure, frame(snapshot(parent.id), snapshot(child.id, { failedAllocation: failed, terminal: true })), parent, child)).toThrow();
});

test("proxy: observer binds exact host launch authority and argv to telemetry transport and preserves posting", () => {
  const oldWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const oldObserver = Object.getOwnPropertyDescriptor(globalThis, "__bunMemoryVerifierActors");
  const sent: unknown[][] = [];
  class FakeWorker { postMessage(...args: unknown[]) { sent.push(args); } }
  const originalPost = FakeWorker.prototype.postMessage;
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  try {
    const serialized: unknown = new Function(`return (${installActorObserver.toString()});`)();
    if (typeof serialized !== "function") throw new Error("observer cannot serialize for page init");
    serialized({ engine, executable: "/opt/bun/quickjs/bin/bun", paths: [actor.path, child.path] });
    const worker = new FakeWorker();
    const message = { engine, args: ["/opt/bun/quickjs/bin/bun", "run", actor.path], env: { BUNWASM_EXEC_PATH: "/opt/bun/quickjs/bin/bun" }, memoryTelemetry: { id: actor.id, buffer: new SharedArrayBuffer(8) } };
    const transfer: unknown[] = [];
    worker.postMessage({ type: "other" });
    worker.postMessage(message, transfer);
    const getter: unknown = Reflect.get(globalThis, "__bunMemoryVerifierActors");
    if (typeof getter !== "function") throw new Error("missing actor observer");
    expect(selectActor(getter(), actor)).toEqual(actor);
    expect(sent[1]?.[0]).toBe(message);
    expect(sent[1]?.[1]).toBe(transfer);
    expect(() => selectActor(getter(), child)).toThrow();
    worker.postMessage(message);
    expect(() => selectActor(getter(), actor)).toThrow();
    const invalids = [
      { ...message, engine: "jsc" },
      { ...message, env: undefined },
      { ...message, env: { BUNWASM_EXEC_PATH: "/wrong/bun" } },
      { ...message, args: ["/wrong/bun", "run", child.path] },
      { ...message, args: [message.args[0], "eval", child.path] },
      { ...message, args: message.args.concat(["extra"]) },
      { ...message, memoryTelemetry: undefined },
      { ...message, memoryTelemetry: { id: "", buffer: new SharedArrayBuffer(8) } },
      { ...message, memoryTelemetry: { id: child.id, buffer: new ArrayBuffer(8) } },
    ];
    for (const invalid of invalids) {
      FakeWorker.prototype.postMessage = originalPost;
      serialized({ engine, executable: "/opt/bun/quickjs/bin/bun", paths: [actor.path, child.path] });
      worker.postMessage(invalid);
      const getter: unknown = Reflect.get(globalThis, "__bunMemoryVerifierActors");
      if (typeof getter !== "function") throw new Error("missing actor observer");
      expect(() => selectActor(getter(), invalid.args[2] === child.path ? child : actor)).toThrow();
    }
  } finally {
    if (oldWorker) Object.defineProperty(globalThis, "Worker", oldWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
    if (oldObserver) Object.defineProperty(globalThis, "__bunMemoryVerifierActors", oldObserver);
    else Reflect.deleteProperty(globalThis, "__bunMemoryVerifierActors");
  }
});

test("proxy: binding validation rejects guessed, wrong and ambiguous actors", () => {
  for (const observations of [[], [{ ...actor, authority: "latest-command" }], [{ ...actor, id: "" }], [{ ...actor, engine: "jsc" }],
    [actor, actor], [actor, { ...child, id: actor.id }], [{ ...actor, path: "/wrong.ts" }], [{ ...actor, error: "invalid launch" }]]) {
    expect(() => selectActor(observations, actor)).toThrow();
  }
});

async function installStartupControls(playwrightModule: string): Promise<void> {
  const childProcess = await import("node:child_process");
  const { PassThrough } = await import("node:stream");
  const { expect, mock, spyOn } = await import("bun:test");
  class StartupServer extends childProcess.ChildProcess {
    stdout = new PassThrough();
    stderr = new PassThrough();
    exitCode: number | null = null;
    signalCode = null;
    pid = 0;
    kill() {
      this.exitCode = 0;
      this.emit("close");
      return true;
    }
  }
  const server = new StartupServer();
  server.stdout.write("at http://127.0.0.1:1\n");
  spyOn(childProcess, "spawn").mockReturnValue(server);
  let connected = true;
  const page = {
    on() {},
    addInitScript(_observer: unknown, options: unknown) {
      expect(options).toEqual({
        engine: "quickjs", executable: "/opt/bun/quickjs/bin/bun",
        paths: ["/home/user/memory-producer.ts", "/home/user/memory-parent.ts", "/home/user/memory-child.ts"],
      });
      throw new Error("Startup reached initialized observer fixtures");
    },
  };
  const browser = {
    newContext: async () => ({ newPage: async () => page, close: async () => {} }),
    close: async () => { connected = false; },
    isConnected: () => connected,
  };
  const launch = async () => browser;
  mock.module(playwrightModule, () => ({ chromium: { launch } }));
  expect((await import(playwrightModule)).chromium.launch).toBe(launch);
}

test("memory browser CLI initializes fixture paths before installing its observer", () => {
  const output = mkdtempSync(join(tmpdir(), "bun-wasm-memory-startup-"));
  try {
    const preload = join(output, "startup-control.ts");
    writeFileSync(preload, `await (${installStartupControls.toString()})(${JSON.stringify(import.meta.resolve("playwright"))});`);
    const result = Bun.spawnSync([process.execPath, "--preload", preload,
      join(import.meta.dir, "verify-engine-memory-browser.ts"), output], {
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Startup reached initialized observer fixtures");
    expect(result.stderr.toString()).not.toContain("before initialization");
    expect(JSON.parse(readFileSync(join(output, "hook-cleanup.json"), "utf8"))).toEqual({
      serverPid: 0, serverExited: true, browserClosed: true,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
