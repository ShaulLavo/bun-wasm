import { expect, test } from "bun:test";
import { service, load } from "../../scripts/spawn-runtime-proc-fixture.ts";

// Synchronous runtime_proc admission failures. Registry/worker startup failures arrive later;
// those are separately exercised below through the typed wait result.
function fixture(failure: "ENOENT" | "EACCES" = "ENOENT") {
  const fake = service({ failSpawn: failure === "ENOENT" ? -44 : -2 });
  const { module: api } = load(fake);
  return { api, host: { dispose() { expect(fake.open()).toBe(0); } } };
}

test("rejected admission releases pipe capabilities on every attempt", () => {
  const fake = service({ failSpawn: -44 });
  const { module: api } = load(fake);
    for (let i = 0; i < 8; i++) {
    expect(() => api.spawn(["missing"])).toThrow(/ENOENT/);
    expect(fake.open()).toBe(0);
    expect(fake.children.size).toBe(0);
    }
});

for (const method of ["spawn", "spawnSync"]) test(`Bun.${method} throws ENOENT for a missing executable`, () => {
  const { host, api } = fixture();
  try {
    let caught;
    try { api[method](["missing", "argument"]); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "Error", code: "ENOENT", errno: -2, path: "missing" });
  } finally { host.dispose(); }
});

function nodeError(sync: boolean) {
  return { name: "Error", code: "ENOENT", errno: -2, path: "missing", syscall: `${sync ? "spawnSync" : "spawn"} missing`, spawnargs: ["argument"] };
}

test("Node spawn emits error then close without spawn or exit", async () => {
  const { host, api } = fixture();
  try {
    const events: string[] = [];
    const child = api.nodeChildProcess().spawn("missing", ["argument"]);
    expect(child.pid).toBeUndefined();
    expect(child.stdin).not.toBeNull();
    expect(child.stdout).not.toBeNull();
    expect(child.stderr).not.toBeNull();
    expect(child.stdio).toEqual([child.stdin, child.stdout, child.stderr]);
    expect(child.exitCode).toBeNull();
    child.on("spawn", () => events.push("spawn"));
    child.on("exit", () => events.push("exit"));
    let ended = 0;
    child.stdin.on("close", () => ended++);
    child.stdout.on("end", () => ended++);
    child.stderr.on("end", () => ended++);
    let failure;
    child.on("error", (error: Error) => { events.push("error"); failure = error; });
    const closed = await new Promise(resolve => child.on("close", (code: number, signal: string | null) => {
      events.push("close"); resolve([code, signal]);
    }));
    expect(failure).toMatchObject(nodeError(false));
    expect(events).toEqual(["error", "close"]);
    expect(closed).toEqual([-2, null]);
    expect(ended).toBe(3);
    expect(child.exitCode).toBe(-2);
  } finally { host.dispose(); }
});

for (const stdio of ["ignore", "inherit", ["ignore", "pipe", "inherit"]]) test(`failed Node spawn preserves requested stdio ${stdio}`, async () => {
  const { host, api } = fixture();
  try {
    const child = api.nodeChildProcess().spawn("missing", [], { stdio });
    expect(child.stdin).toBeNull();
    expect(child.stderr).toBeNull();
    if (Array.isArray(stdio)) expect(child.stdout).not.toBeNull();
    else expect(child.stdout).toBeNull();
    child.on("error", () => {});
    await new Promise(resolve => child.once("close", resolve));
    expect(child.stdin?.destroyed ?? true).toBe(true);
    expect(child.stdout?.readableEnded ?? true).toBe(true);
  } finally { host.dispose(); }
});

test("Node spawnSync returns an ENOENT error with null status", () => {
  const { host, api } = fixture();
  try {
    const result = api.nodeChildProcess().spawnSync("missing", ["argument"]);
    expect(result.error).toMatchObject(nodeError(true));
    expect(result.status).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.output).toBeNull();
    expect(result.stdout).toBeUndefined();
    expect(result.stderr).toBeUndefined();
  } finally { host.dispose(); }
});

for (const method of ["spawn", "spawnSync"]) test(`Bun.${method} throws EACCES for an unrunnable executable`, () => {
  const { host, api } = fixture("EACCES");
  try {
    let caught;
    try { api[method](["broken"]); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "Error", code: "EACCES", errno: -13, path: "broken", syscall: "spawn" });
    const result = api.nodeChildProcess().spawnSync("broken", ["argument"]);
    expect(result.error).toMatchObject({ code: "EACCES", errno: -13, syscall: "spawnSync broken", path: "broken", spawnargs: ["argument"] });
    expect(result.status).toBeNull();
  } finally { host.dispose(); }
});

test("Node spawn reports EACCES before close for an unrunnable executable", async () => {
  const { host, api } = fixture("EACCES");
  try {
    const child = api.nodeChildProcess().spawn("broken", ["argument"]);
    let failure;
    child.on("error", (error: Error) => { failure = error; });
    const closed = await new Promise(resolve => child.once("close", (code: number | null, signal: string | null) => resolve([code, signal])));
    expect(failure).toMatchObject({ code: "EACCES", errno: -13, syscall: "spawn broken", path: "broken", spawnargs: ["argument"] });
    expect(child.exitCode).toBe(-13);
    expect(closed).toEqual([-13, null]);
    expect(child.pid).toBeUndefined();
  } finally { host.dispose(); }
});

test("a null abort reason reaches Node's asynchronous error path", async () => {
  const { host, api } = fixture();
  try {
    const controller = new AbortController();
    controller.abort(null);
    const child = api.nodeChildProcess().spawn("bun", [], { signal: controller.signal });
    let failure: unknown = "unset";
    child.on("error", (error: unknown) => { failure = error; });
    await new Promise(resolve => child.once("close", resolve));
    expect(failure).toBeNull();
  } finally { host.dispose(); }
});

const startupErrors = [
  ["ENOENT", 44, -2], ["EACCES", 2, -13], ["ENOTDIR", 54, -20],
  ["ENOEXEC", 45, -8], ["ENOMEM", 48, -12], ["EAGAIN", 6, -11], ["EIO", 29, -5],
] as const;

for (const [code, wasiErrno, errno] of startupErrors) {
  function startupFixture() {
    const fake = service({ onSpawn(child) { fake.select(child, [2, wasiErrno]); fake.publish(child); } });
    let waits = 0;
    const wait = fake.native.procWait;
    fake.native.procWait = (pid: number) => { waits++; return wait(pid); };
    return { fake, ...load(fake), waits: () => waits };
  }
  test(`Bun asynchronous ${code} startup rejects with typed errno and releases every capability`, async () => {
    const { fake, module: api, pump, waits } = startupFixture();
    const exits: unknown[][] = [];
    const child = api.spawn(["/bin/bun", "argument"], { stdin: "pipe", stderr: "pipe", detached: true,
      onExit(...args: unknown[]) { exits.push(args); } });
    const failure = child.exited.catch((error: unknown) => error);
    await pump();
    expect(await failure).toMatchObject({ code, errno, path: "/bin/bun", syscall: "spawn" });
    expect(exits).toHaveLength(1);
    expect(exits[0]!.slice(1, 3)).toEqual([null, null]);
    expect(exits[0]![3]).toMatchObject({ code, errno });
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    expect(await child.stdout.text()).toBe(""); expect(await child.stderr.text()).toBe("");
    expect(waits()).toBe(1); expect(fake.open()).toBe(0);
    expect(fake.calls.filter(call => call.startsWith("kill"))).toEqual([]);
    expect(fake.calls.filter(call => call === "reap")).toHaveLength(1);
  });
  test(`Bun synchronous ${code} startup throws after cleanup and Node preserves error metadata`, () => {
    for (const node of [false, true]) {
      const { fake, module: api, waits } = startupFixture();
      if (node) {
        const result = api.nodeChildProcess().spawnSync("/bin/bun", ["argument"], { detached: true });
        expect(result.error).toMatchObject({ code, errno, path: "/bin/bun", syscall: "spawnSync /bin/bun", spawnargs: ["argument"] });
        expect(result.status).toBeNull(); expect(result.signal).toBeNull();
      } else {
        let failure: unknown;
        try { api.spawnSync(["/bin/bun", "argument"], { detached: true }); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code, errno, path: "/bin/bun", syscall: "spawn" });
      }
      expect(waits()).toBe(1); expect(fake.open()).toBe(0);
      expect(fake.calls.filter(call => call.startsWith("kill"))).toEqual([]);
    }
  });
  test(`Node asynchronous ${code} startup emits error then close and never exit`, async () => {
    const { fake, module: api, pump } = startupFixture();
    const events: string[] = [];
    const child = api.nodeChildProcess().spawn("/bin/bun", ["argument"]);
    let failure: unknown;
    for (const event of ["exit", "error", "close"]) child.on(event, () => events.push(event));
    child.on("error", (error: unknown) => { failure = error; });
    const closed = new Promise(resolve => child.once("close", (code: number, signal: string | null) => resolve([code, signal])));
    await pump();
    expect(await closed).toEqual([errno, null]);
    expect(failure).toMatchObject({ code, errno, path: "/bin/bun", syscall: "spawn /bin/bun", spawnargs: ["argument"] });
    expect(events).toEqual(["error", "close"]); expect(child.exitCode).toBe(errno); expect(fake.open()).toBe(0);
  });
  test(`asynchronous ${code} startup emits error/close, not spawn/exit`, async () => {
    const { fake, module: api, pump } = startupFixture();
    const events: string[] = [];
    const child = api.nodeChildProcess().spawn("/bin/bun", ["argument"]);
    for (const event of ["spawn", "exit", "error", "close"]) child.on(event, () => events.push(event));
    const closed = new Promise(resolve => child.once("close", resolve));
    await pump(); await closed;
    expect(events).toEqual(["error", "close"]); expect(fake.open()).toBe(0);
  });
}

for (const code of [126, 127]) test(`real guest exit ${code} stays an ordinary Bun and Node exit`, async () => {
  for (const node of [false, true]) {
    const fake = service({ onSpawn(child) { fake.exit(child, code); } });
    const { module: api, pump } = load(fake);
    const child = node ? api.nodeChildProcess().spawn("/bin/bun") : api.spawn(["/bin/bun"]);
    if (node) {
      const events: string[] = [];
      child.on("error", () => events.push("error"));
      const closed = new Promise(resolve => child.once("close", (status: number, signal: string | null) => resolve([status, signal])));
      await pump(); expect(await closed).toEqual([code, null]); expect(events).toEqual([]);
    } else { await pump(); expect(await child.exited).toBe(code); expect(child.exitCode).toBe(code); }
    expect(fake.open()).toBe(0);
    const sync = node ? api.nodeChildProcess().spawnSync("/bin/bun") : api.spawnSync(["/bin/bun"]);
    expect(sync.error).toBeUndefined(); expect(node ? sync.status : sync.exitCode).toBe(code);
    expect(fake.open()).toBe(0);
  }
});

test("Node spawn waits for entry, then allows stdin from its spawn listener without output or completion", async () => {
  const fake = service({ deferStart: true });
  const { module: api, waiters, pumpTurn, pump } = load(fake);
  const events: string[] = [];
  const child = api.nodeChildProcess().spawn("/bin/bun", ["read-stdin"]);
  child.on("error", (error: unknown) => { throw error; });
  child.on("spawn", () => { events.push("spawn"); child.stdin.end("from-spawn"); });
  child.on("exit", () => events.push("exit"));
  const closed = new Promise(resolve => child.once("close", () => { events.push("close"); resolve(undefined); }));
  const admitted = Array.from(fake.children.values())[0]!;
  pumpTurn(); await Promise.resolve();
  expect(events).toEqual([]);
  const subscriptions = new DataView(waiters[0].subscriptions().buffer);
  const kinds = Array.from({ length: subscriptions.byteLength / 16 }, (_, index) => subscriptions.getUint32(index * 16, true));
  expect(kinds).toContain(6);
  admitted.started = true;
  pumpTurn(); await Promise.resolve();
  expect(events).toEqual(["spawn"]);
  expect(fake.childRead(admitted, 0)).toBe("from-spawn");
  expect(admitted.status).toBeNull();
  const afterStart = waiters[0].subscriptions();
  expect(Array.from({ length: afterStart.length / 16 }, (_, index) => new DataView(afterStart.buffer).getUint32(index * 16, true))).not.toContain(6);
  fake.exit(admitted, 0);
  await pump(); await closed;
  expect(events).toEqual(["spawn", "exit", "close"]);
  expect(fake.open()).toBe(0);
});
