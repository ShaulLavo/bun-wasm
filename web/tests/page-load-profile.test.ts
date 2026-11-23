// Process cleanup for sandbox/tests/page-load-profile.ts. Its page observer needs a browser and
// is checked in scripts/page-load-observer-browser.test.ts.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildGroup, ContextGroup, requireUniqueNames, runAll } from "../../sandbox/tests/page-load-support";

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
