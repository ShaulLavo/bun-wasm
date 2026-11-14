import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { withNativeDriver, type NativeHost } from "./native";
import { ownSafariDriver } from "../../web/tests/engine-interruption-safari";
import { ExitOwner } from "./safari-exit-observer";
import { openExit, type ExitSyscalls } from "./safari-exit-syscalls";
import { fakeNative } from "./safari-exit-fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(joinMs = 1000) {
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const controller = new AbortController();
  const events: string[] = [];
  const native = fakeNative();
  const pending: number[] = [];
  let closes = 0;
  const root = await mkdtemp("/work/tmp/bun-wasm-native-exit-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  if (process.env.LIFECYCLE_DIRECTORY_LEDGER) await appendFile(process.env.LIFECYCLE_DIRECTORY_LEDGER, root + "\n");
  const system: ExitSyscalls = {
    kqueue: () => 11, errno: () => 0,
    kevent64(_fd, change, event) {
      const data = change ? 0 : pending.shift();
      if (data === undefined) return 0;
      const view = new DataView(event.buffer);
      view.setBigUint64(0, 101n, true); view.setInt16(8, -5, true);
      view.setUint16(10, change ? 0x4041 : 0x8071, true);
      view.setUint32(12, 0x86000000, true); view.setBigInt64(16, BigInt(data), true);
      return 1;
    },
    close() { closes++; events.push("descriptor-close"); return 0; },
  };
  const owner = new ExitOwner({ native: native.native, open: pid => openExit(system, pid), joinMs,
    sink: { async write() {}, async close() { events.push("writers-close"); } } });
  cleanup.push(() => owner.finish());
  cleanup.push(async () => { for (const child of children) await stop(child); });
  async function spawn() {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    children.push(child);
    if (process.env.LIFECYCLE_PID_LEDGER) await appendFile(process.env.LIFECYCLE_PID_LEDGER, String(child.pid) + "\n");
    return child;
  }
  // The driver's spawn boundary is synchronous. Teardown was installed before either spawn.
  const driver = await spawn();
  const app = await spawn();
  const io: NativeHost = {
    platform: "darwin", uid: () => 501, signals: operation => operation(controller.signal),
    queue: async () => { events.push("queue"); }, available: async () => {}, console: async () => "",
    prepare: async state => { events.push("prepare"); state.launch = { kind: "owned", process: app, application: { pid: app.pid, started: 1 } }; },
    port: async () => 12345, spawn: () => driver, own: ownSafariDriver, ready: async () => true,
    stopDriver: async () => { events.push("driver-stop"); pending.push(9); await stop(driver); },
    stopApp: async state => { events.push("app-stop"); pending.push(15); if (state.launch.kind !== "none") await stop(state.launch.process); },
  };
  const config = { desktopSafari: true, cleanupFile: join(root, "receipt.json"), exitOwner: owner };
  return { root, io, owner, config, events, native, pending, controller, driver, app, get closes() { return closes; } };
}

async function stop(child: Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "signalCode" | "kill" | "exited">) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await child.exited;
}

test("actual native wrapper retains the operation error and attempts the app after driver failure, then drains and closes", async () => {
  const f = await fixture();
  const original = new Error("invalid protocol reply");
  const stopDriver = f.io.stopDriver;
  f.io.stopDriver = async (...args) => { await stopDriver(...args); throw new Error("driver cleanup failure"); };
  const result = await f.owner.run(() => withNativeDriver(async () => {
    f.owner.attach({ pid: 101, birth: "7" });
    f.native.births.set(101, "replacement");
    f.events.push("inner-capture-settled");
    throw original;
  }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.events).toEqual(["queue", "prepare", "inner-capture-settled", "driver-stop", "app-stop", "descriptor-close", "writers-close"]);
  expect(f.closes).toBe(1);
  expect(f.owner.proof()).toMatchObject({ state: "unproved", eventCount: 2, descriptor: "closed", childrenJoined: true, cleanupCompleted: false });
  expect(f.owner.cleanup[0]?.result).toMatchObject({ outcome: { kind: "error", error: { message: "driver cleanup failure" } } });
  expect(f.owner.records.filter(entry => entry.kind === "exit-poll").every(entry => entry.target?.birth === "7")).toBe(true);
  expect(JSON.parse(await readFile(f.config.cleanupFile, "utf8"))).toMatchObject({ driverExited: false, safariExited: true });
});

test("actual native wrapper returns the identical result after joined teardown without waiting for target death", async () => {
  const f = await fixture();
  const status = { status: "fail", error: "guest error" };
  f.io.stopDriver = async () => { await stop(f.driver); };
  f.io.stopApp = async () => { await stop(f.app); };
  const result = await f.owner.run(() => withNativeDriver(async () => { f.owner.attach({ pid: 101, birth: "7" }); return status; }, f.config, f.io));
  expect(result).toBe(status);
  expect(f.owner.proof()).toMatchObject({ state: "settled", eventCount: 0, cleanupCompleted: true });
  expect(JSON.parse(await readFile(f.config.cleanupFile, "utf8"))).toMatchObject({ driverExited: true, safariExited: true });
});

test.each(["queue", "prepare", "port", "spawn", "ready", "cancel"])("partial native construction at %s preserves the failure and attempts both teardown steps", async stage => {
  const f = await fixture();
  const original = new Error(`original ${stage}`);
  const fail = async () => { throw original; };
  if (stage === "queue") f.io.queue = fail;
  if (stage === "prepare" || stage === "cancel") {
    const prepare = f.io.prepare;
    f.io.prepare = async (...args) => { await prepare(...args); if (stage === "cancel") f.controller.abort(original); throw original; };
  }
  if (stage === "port") f.io.port = fail;
  if (stage === "spawn") f.io.spawn = () => { throw original; };
  if (stage === "ready") f.io.ready = fail;
  const result = await f.owner.run(() => withNativeDriver(async () => { throw new Error("workload admitted"); }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.events).toContain("app-stop");
  expect(f.owner.cleanup.map(step => step.phase)).toEqual(["driver-teardown", "app-teardown", "final-drain"]);
  expect(f.owner.proof()).toMatchObject({ descriptor: "not-opened", writersClosed: true });
});

test.each(["driver", "app"])("noncooperative %s teardown is bounded and remains unproved while later steps run", async stage => {
  const f = await fixture(100);
  const original = new Error("operation failed");
  const hang = () => new Promise<void>(() => {});
  if (stage === "driver") f.io.stopDriver = async () => { await stop(f.driver); return hang(); };
  if (stage === "app") f.io.stopApp = async () => { await stop(f.app); return hang(); };
  const result = await f.owner.run(() => withNativeDriver(async () => { f.owner.attach({ pid: 101, birth: "7" }); throw original; }, f.config, f.io)).catch(error => error);
  expect(result).toBe(original);
  expect(f.owner.cleanup.at(-1)?.phase).toBe("final-drain");
  expect(f.owner.proof()).toMatchObject({ state: "unproved", childrenJoined: false, descriptor: "closed", writersClosed: true });
  expect(f.closes).toBe(1);
});
