import { expect, test } from "bun:test";
import { service, load } from "../../scripts/spawn-runtime-proc-fixture.ts";

// Synchronous runtime_proc admission failures. Registry/worker startup failures arrive later;
// those are separately exercised below once Waffle's typed start-failure wait ABI lands.
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
    const closed = await new Promise(resolve => child.once("close", (code, signal) => resolve([code, signal])));
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
    let failure = "unset";
    child.on("error", (error) => { failure = error; });
    await new Promise(resolve => child.once("close", resolve));
    expect(failure).toBeNull();
  } finally { host.dispose(); }
});

for (const [code, wasiErrno, errno] of [["ENOENT", -44, -2], ["EACCES", -2, -13]] as const) {
  test.skip(`asynchronous ${code} startup emits error/close, not spawn/exit (pending Waffle typed start-failure ABI)`, async () => {
    const fake = service();
    // The generic wait ABI must distinguish this failure from ordinary 127/126 exits.
    fake.native.procWait = () => wasiErrno;
    const { module: api, pump } = load(fake);
    const events: string[] = [];
    const child = api.nodeChildProcess().spawn("missing", ["argument"]);
    let failure: unknown;
    for (const event of ["spawn", "exit", "error", "close"]) child.on(event, () => events.push(event));
    child.on("error", (error: unknown) => { failure = error; });
    await pump();
    await new Promise(resolve => setImmediate(resolve));
    expect(failure).toMatchObject({ code, errno, path: "missing", syscall: "spawn missing", spawnargs: ["argument"] });
    expect(events).toEqual(["error", "close"]);
    expect(child.exitCode).toBe(errno);
  });
}
