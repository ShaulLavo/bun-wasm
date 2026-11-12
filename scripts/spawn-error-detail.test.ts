import { expect, test } from "bun:test";
import { load, service } from "./spawn-runtime-proc-fixture";

const detail = "ProcessError: adapter startup failed\ncaused by TypeError: cannot clone module";
interface SpawnError extends Error { code: string; errno: number; syscall: string }

function expectErrno(error: SpawnError, syscall = "spawn") {
  expect(error.code).toBe("EIO");
  expect(error.errno).toBe(-5);
  expect(error.syscall).toBe(syscall);
}

test("synchronous spawn copies the caller diagnostic before cleanup can spawn again", () => {
  const fake = service({ failSpawn: -29, spawnDetail: detail });
  const close = fake.native.procClose;
  fake.native.procClose = (fd: number) => {
    if (fake.calls.includes("spawn")) fake.native.procSpawnError = () => "later failure";
    return close(fd);
  };
  const { module } = load(fake);
  expect(() => module.spawn(["bun"], { stdio: "pipe" })).toThrow(detail);
  expect(fake.calls).toEqual(["spawn", "spawnError:0"]);
  expect(fake.open()).toBe(0);
});

for (const api of ["bun", "node"] as const) test(`${api} synchronous failure keeps errno and original detail`, async () => {
  const fake = service({ failSpawn: -29, spawnDetail: detail });
  const { module } = load(fake);
  if (api === "bun") {
    expect(() => module.spawnSync(["bun"], {})).toThrow(detail);
    return;
  }
  const node = module.nodeChildProcess();
  const result = node.spawnSync("bun", []);
  expectErrno(result.error, "spawnSync bun");
  expect(result.error.message).toContain(detail);
  const child = node.spawn("bun", []);
  const error = await new Promise<SpawnError>(resolve => child.once("error", resolve));
  expectErrno(error, "spawn bun");
  expect(error.message).toContain(detail);
});

for (const killProbe of [false, true]) test(`async startup copies detail before collection, kill probe ${killProbe}`, async () => {
  const fake = service({ deferStart: true, spawnDetail: detail });
  const { module, pump } = load(fake);
  const child = module.nodeChildProcess().spawn("bun", []);
  const errors: SpawnError[] = [];
  child.on("error", (error: SpawnError) => errors.push(error));
  const record = fake.children.get(child.pid)!;
  fake.select(record, [2, 29]);
  fake.publish(record);
  if (killProbe) child.kill(0);
  await pump();
  expect(errors).toHaveLength(1);
  expectErrno(errors[0]!, "spawn bun");
  expect(errors[0]!.message).toContain(detail);
  expect(fake.native.procSpawnError(child.pid)).toBe(-12);
  expect(fake.open()).toBe(0);
});

test("Bun onExit and exited share the diagnostic after the host record expires", async () => {
  const fake = service({ deferStart: true, spawnDetail: detail });
  const { module, pump } = load(fake);
  const callbacks: unknown[] = [];
  const child = module.spawn(["bun"], { onExit(_child: unknown, _code: unknown, _signal: unknown, error: unknown) { callbacks.push(error); } });
  const rejected = child.exited.catch((error: unknown) => error);
  const record = fake.children.get(child.pid)!;
  fake.select(record, [2, 29]);
  fake.publish(record);
  await pump();
  const error = await rejected;
  expectErrno(error);
  expect(error.message).toContain(detail);
  expect(callbacks).toEqual([error]);
});

test("spawnSync never consumes a failure published after a pending startup observation", () => {
  const fake = service({ deferStart: true, spawnDetail: detail });
  const status = fake.native.procStartStatus;
  let raced = false;
  fake.native.procStartStatus = (pid: number) => {
    const result = status(pid);
    if (raced) return result;
    raced = true;
    const record = fake.children.get(pid)!;
    fake.select(record, [2, 29]);
    fake.publish(record);
    return -6;
  };
  const wait = fake.native.procWait;
  fake.native.procWait = (pid: number) => {
    expect(fake.calls).toContain(`spawnError:${pid}`);
    return wait(pid);
  };
  const { module } = load(fake);
  expect(() => module.spawnSync(["bun"], { detached: true })).toThrow(detail);
  expect(fake.calls).toContain("reap");
  expect(fake.open()).toBe(0);
});

test("a selected startup failure waits for diagnostic publication before consuming", async () => {
  const fake = service({ deferStart: true, spawnDetail: detail });
  const diagnostic = fake.native.procSpawnError;
  let ready = false;
  fake.native.procSpawnError = (pid: number) => ready ? diagnostic(pid) : -6;
  const { module, pumpTurn, pump } = load(fake);
  const child = module.spawn(["bun"], {});
  const rejected = child.exited.catch((error: unknown) => error);
  const record = fake.children.get(child.pid)!;
  fake.select(record, [2, 29]);
  fake.publish(record);
  pumpTurn();
  expect(record.waited).toBeUndefined();
  ready = true;
  await pump();
  expect((await rejected).message).toContain(detail);
});

for (const queryResult of ["", -52]) test(`missing diagnostic ${queryResult} preserves errno semantics`, () => {
  const fake = service({ failSpawn: -29 });
  fake.native.procSpawnError = () => queryResult;
  const { module } = load(fake);
  const { error } = module.nodeChildProcess().spawnSync("bun", []);
  expectErrno(error, "spawnSync bun");
  expect(error.message).toBe("spawn bun EIO");
});
