// Process cleanup for sandbox/tests/page-load-profile.ts. Its page observer needs a browser and
// is checked in scripts/page-load-observer-browser.test.ts.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker as PlaywrightWorker } from "playwright";
import { ChildGroup, ContextGroup, requireUniqueNames, runAll, StorageReadObserver, storagePhases, type StoragePhase, type StorageRead } from "../../sandbox/tests/page-load-support";

test("variants with the same name are refused before anything starts", () => {
  expect(() => requireUniqueNames(["before", "after"])).not.toThrow();
  expect(() => requireUniqueNames(["before", "before"])).toThrow("Variant before is named twice");
});

test("a server that ignores SIGTERM is killed and its exit awaited", async () => {
  const group = new ChildGroup();
  const child = group.spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>(resolveUp => child.stdout!.once("data", () => resolveUp()));
  await group.stop(200);
  expect(child.signalCode).toBe("SIGKILL");
});

test("a server that never spawns does not hold up teardown", async () => {
  const group = new ChildGroup();
  const child = group.spawn(join(tmpdir(), "bun-wasm-page-load-missing-server"), [], { stdio: "ignore" });
  const failed = new Promise<Error>(resolveError => child.once("error", resolveError));
  expect((await failed).message).toContain("ENOENT");
  const stopped = await Promise.race([group.stop(200).then(() => true), Bun.sleep(5000).then(() => false)]);
  expect(stopped).toBe(true);
});

test("teardown closes a browser context that is still launching", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  const launch = Promise.withResolvers<{ close(): Promise<void> }>();
  let closed = 0;
  const visit = group.open(() => launch.promise, async () => "visited");
  const teardown = group.closeAll();
  launch.resolve({ close: async () => { closed++; } });
  await teardown;
  expect(await visit).toBe("visited");
  expect(closed).toBeGreaterThan(0);
});

test("teardown waits for a context close that is already under way", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  const closing = Promise.withResolvers<void>();
  const visit = group.open(async () => ({ close: () => closing.promise }), async () => "visited");
  await Bun.sleep(1);
  let finished = false;
  const teardown = group.closeAll().then(() => { finished = true; });
  await Bun.sleep(20);
  expect(finished).toBe(false);
  closing.resolve();
  await teardown;
  expect(await visit).toBe("visited");
});

test("teardown happens once and refuses later launches", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  let launched = 0;
  const first = group.closeAll();
  expect(group.closeAll()).toBe(first);
  const refused = await group.open(async () => { launched++; return { close: async () => {} }; }, async () => "visited")
    .then(() => () => {}, (error: unknown) => () => { throw error; });
  expect(refused).toThrow("no new launch");
  expect(launched).toBe(0);
  await first;
});

const outcome = (pending: Promise<unknown>) => pending.then(() => () => {}, (error: unknown) => () => { throw error; });

test("a context that fails to close fails its visit, so its profile is not reused", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  const visited = await outcome(group.open(async () => ({ close: async () => { throw new Error("close failed"); } }), async () => "visited"));
  expect(visited).toThrow("close failed");
});

test("teardown closes every context, then reports a close that failed", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  const using = Promise.withResolvers<void>();
  let closed = 0;
  const failing = group.open(async () => ({ close: async () => { throw new Error("close failed"); } }), () => using.promise);
  const healthy = group.open(async () => ({ close: async () => { closed++; } }), () => using.promise);
  await Bun.sleep(1);
  const teardown = outcome(group.closeAll());
  using.resolve();
  expect(await teardown).toThrow("Teardown failed");
  expect(closed).toBeGreaterThan(0);
  expect(await outcome(failing)).toThrow("close failed");
  expect(await outcome(healthy)).not.toThrow();
});

test("a visit's close and teardown share one context.close(), and both see it fail", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  const closing = Promise.withResolvers<void>();
  let calls = 0;
  const visited = group.open(async () => ({ close: () => { calls++; return closing.promise; } }), async () => "visited");
  await Bun.sleep(1);
  const teardown = outcome(group.closeAll());
  closing.reject(new Error("close failed"));
  expect(await teardown).toThrow("Teardown failed");
  expect(await outcome(visited)).toThrow("close failed");
  expect(calls).toBe(1);
});

test("a context that fails to close while teardown waits on another is closed once and reported", async () => {
  const group = new ContextGroup<{ close(): Promise<void> }>();
  const [usingA, closingA, closingB] = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const failure = new Error("B close failed");
  let callsB = 0;
  const visitA = group.open(async () => ({ close: () => closingA.promise }), () => usingA.promise);
  const visitB = group.open(async () => ({ close: () => { callsB++; return closingB.promise; } }), async () => "visited");
  await Bun.sleep(1);
  // Teardown waits on A first; B's visit close fails meanwhile, before teardown reaches B.
  const teardown = group.closeAll().then(() => [], (error: unknown) => error instanceof AggregateError ? error.errors : [error]);
  closingB.reject(failure);
  expect(await outcome(visitB)).toThrow("B close failed");
  closingA.resolve();
  usingA.resolve();
  expect(await teardown).toEqual([failure]);
  expect(callsB).toBe(1);
  expect(await outcome(visitA)).not.toThrow();
});

test("each teardown step runs even when an earlier one fails", async () => {
  const steps: string[] = [];
  const result = await outcome(runAll([
    async () => { steps.push("contexts"); throw new Error("close failed"); },
    async () => { steps.push("servers"); },
    async () => { steps.push("profiles"); },
  ]));
  expect(steps).toEqual(["contexts", "servers", "profiles"]);
  expect(result).toThrow("Teardown failed");
});

test("interrupting the profiler stops the servers it started", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-page-load-interrupt-"));
  try {
    const script = join(scratch, "interrupted.ts");
    const support = join(import.meta.dir, "../../sandbox/tests/page-load-support.ts");
    await writeFile(script, `import { ChildGroup, onInterrupt } from ${JSON.stringify(support)};
const group = new ChildGroup();
const server = group.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
onInterrupt(() => group.stop(2000));
console.log(server.pid);
setInterval(() => {}, 1000);
`);
    const profiler = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const pid = Number(await new Promise<string>(resolvePid => profiler.stdout!.once("data", (chunk: Buffer) => resolvePid(chunk.toString().trim()))));
    const exited = new Promise<number | null>(resolveExit => profiler.once("exit", code => resolveExit(code)));
    profiler.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);

const origin = 1_000_000;
const read = (start: number, kind: StorageRead["kind"] = "get", extra: Partial<StorageRead> = {}): StorageRead =>
  ({ kind, start: origin + start, end: origin + start + 2, bytes: 10, ...extra });
const summary = (phases: readonly StoragePhase[]) => phases.map(({ phase, reads, digests, bytes, files }) => ({ phase, reads, digests, bytes, files }));

test("storage reads land in the stage they started in, and digests are counted apart", () => {
  const stages = [{ name: "bunwasm:stage:workspace-ready", end: 100 }, { name: "bunwasm:dev-server", end: 300 }, { name: "bunwasm:other", end: 50 }];
  const phases = storagePhases(stages, 300, origin, [read(10, "get", { file: 70_000 }), read(150), read(160, "sha256"), read(400)]);
  expect(summary(phases)).toEqual([
    { phase: "workspace-ready", reads: 1, digests: 0, bytes: 10, files: { 70000: 1 } },
    { phase: "dev-server", reads: 1, digests: 1, bytes: 10, files: {} },
    { phase: "after-ready", reads: 1, digests: 0, bytes: 10, files: {} },
  ]);
});

test("work after readiness is after-ready even when a later stage is marked", () => {
  const stages = [{ name: "bunwasm:stage:workspace-ready", end: 50 }, { name: "bunwasm:stage:shell-exited", end: 200 }];
  const phases = storagePhases(stages, 100, origin, [read(40), read(80), read(150), read(250)]);
  expect(summary(phases).map(({ phase, reads }) => ({ phase, reads }))).toEqual([
    { phase: "workspace-ready", reads: 1 }, { phase: "ready", reads: 1 }, { phase: "after-ready", reads: 2 },
  ]);
});

test("readiness bounds startup for builds without stage marks", () => {
  const phases = storagePhases([], 500, origin, [read(10), read(499), read(600)]);
  expect(summary(phases).map(({ phase, reads }) => ({ phase, reads }))).toEqual([{ phase: "ready", reads: 2 }, { phase: "after-ready", reads: 1 }]);
});

/** A stand-in for Playwright's Worker: each evaluation is answered by `answer`, in call order. */
function fakeWorker(url: string, answer: (call: number) => Promise<unknown>) {
  const closeListeners: (() => void)[] = [];
  let calls = 0;
  const worker = {
    url: () => url,
    evaluate: () => answer(calls++),
    on: (event: string, listener: () => void) => { if (event === "close") closeListeners.push(listener); },
  };
  return { worker: worker as unknown as PlaywrightWorker, close: () => { for (const listener of closeListeners) listener(); } };
}

test("workers that block, fail or close are reported with their reason, and their reads are not counted", async () => {
  const observer = new StorageReadObserver();
  const reads: StorageRead[] = [read(1, "sha256")];
  observer.watch(fakeWorker("http://x/observed.js", call => Promise.resolve(call === 0 ? origin + 5 : reads)).worker);
  observer.watch(fakeWorker("http://x/blocked.js", () => new Promise(() => {})).worker);
  observer.watch(fakeWorker("http://x/failed.js", () => Promise.reject(new Error("Target closed\nstack"))).worker);
  const closing = fakeWorker("http://x/closing.js", call => Promise.resolve(call === 0 ? origin : reads));
  observer.watch(closing.worker);
  closing.close();
  const collected = await observer.collect(50);
  expect(collected.reads).toEqual(reads);
  expect(collected.workers.map(({ url, status, reason, reads: count, installedAt }) => ({ url, status, reason, reads: count, installedAt }))).toEqual([
    { url: "http://x/observed.js", status: "observed", reason: undefined, reads: 1, installedAt: origin + 5 },
    { url: "http://x/blocked.js", status: "unavailable", reason: "counter not installed within 50 ms", reads: 0, installedAt: undefined },
    { url: "http://x/failed.js", status: "unavailable", reason: "counter not installed: Target closed", reads: 0, installedAt: undefined },
    { url: "http://x/closing.js", status: "unavailable", reason: "closed before collection", reads: 0, installedAt: undefined },
  ]);
});

test("a worker whose reads cannot be read back is reported with its install time, not counted as idle", async () => {
  const observer = new StorageReadObserver();
  const installed = (later: () => Promise<unknown>) => (call: number) => call === 0 ? Promise.resolve(origin + 7) : later();
  observer.watch(fakeWorker("http://x/stuck.js", installed(() => new Promise(() => {}))).worker);
  observer.watch(fakeWorker("http://x/rejected.js", installed(() => Promise.reject(new Error("Execution context was destroyed")))).worker);
  observer.watch(fakeWorker("http://x/missing.js", installed(() => Promise.resolve(null))).worker);
  // Closes while its reads are being read back, after the counter was installed.
  const closing = fakeWorker("http://x/closed-late.js", installed(() => {
    closing.close();
    return Promise.reject(new Error("Target closed"));
  }));
  observer.watch(closing.worker);
  const collected = await observer.collect(50);
  expect(collected.reads).toEqual([]);
  expect(collected.workers.map(({ url, status, reason, reads: count, installedAt }) => ({ url, status, reason, reads: count, installedAt }))).toEqual([
    { url: "http://x/stuck.js", status: "unavailable", reason: "reads not collected within 50 ms", reads: 0, installedAt: origin + 7 },
    { url: "http://x/rejected.js", status: "unavailable", reason: "reads not collected: Execution context was destroyed", reads: 0, installedAt: origin + 7 },
    { url: "http://x/missing.js", status: "unavailable", reason: "counter buffer missing", reads: 0, installedAt: origin + 7 },
    { url: "http://x/closed-late.js", status: "unavailable", reason: "closed before collection", reads: 0, installedAt: origin + 7 },
  ]);
});

test("a visit that never became ready keeps later reads after its last stage, not after readiness", () => {
  const phases = storagePhases([{ name: "bunwasm:stage:install-start", end: 100 }], null, origin, [read(50), read(5_000)]);
  expect(summary(phases).map(({ phase, reads }) => ({ phase, reads }))).toEqual([{ phase: "install-start", reads: 1 }, { phase: "after-last-stage", reads: 1 }]);
});
