import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import { posix } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { SubprocessHost, childTransport } from "../src/subprocess.ts";
import { launchNodeExecutable } from "../scripts/node-spawn.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/spawn.js", import.meta.url), "utf8");
const packageSource = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false }).transformSync("globalThis.factory = " + readFileSync(new URL("../../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8"));
function fixture(failure?: "ENOENT" | "EACCES") {
  const host = new SubprocessHost({
    output() {},
    launch(meta, transport) {
      if (!failure) return launchNodeExecutable(meta, transport, () => { throw new Error("unexpected launch"); });
      childTransport(transport).startFailed(failure);
      return { terminate() {} };
    },
  });
  const api = runInNewContext(source, { process: { env: {} }, URL, setImmediate, AbortController })({
    require(name: string) {
      if (name !== "package_scripts") return require(name);
      return runInNewContext(packageSource, { URL })({
        native: { exists: () => false },
        require: (name: string) => name === "process" ? { env: {}, cwd: () => "/" } : name === "path" ? posix : require(name),
      });
    },
    builtin: require, nextTick: process.nextTick,
    web: { ReadableStream, Response }, concatBytes: (chunks: Uint8Array[]) => Buffer.concat(chunks),
    addIoWaiter(waiter: { step(): unknown }) { queueMicrotask(() => waiter.step()); return waiter; },
    native: { cwd: () => "/", now: () => performance.now(), ...host.engineNet().natives, hostCaps: { spawn: true } },
  });
  return { host, api };
}

test("missing executable is a startup error and releases reserved capacity", () => {
  const { host } = fixture();
  try {
    for (let i = 0; i < 8; i++) {
      expect(host.spawn(JSON.stringify({ argv: ["missing"] }))).toBe(-1);
      expect(JSON.parse(host.lastError!)).toMatchObject({
        message: 'Executable not found in $PATH: "missing"', code: "ENOENT", errno: -2, path: "missing",
      });
      expect(host.children.size).toBe(0);
      expect(host.handles.size).toBe(0);
      expect(Array.from(new Int32Array(host.budget).subarray(2))).toEqual([0, 0, 0, 0]);
    }
  } finally { host.dispose(); }
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

test("the Bun host waits for a real worker startup result before returning a child", () => {
  const result = nativeSpawnSync("node", ["--no-warnings", new URL("./spawn-start-probe.ts", import.meta.url).pathname], { timeout: 3000, killSignal: "SIGKILL", encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("startup acknowledgement and typed failures passed\n");
});

for (const method of ["spawn", "spawnSync"]) test(`Bun.${method} throws EACCES for an unrunnable executable`, () => {
  const { host, api } = fixture("EACCES");
  try {
    let caught;
    try { api[method](["broken"]); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "Error", code: "EACCES", errno: -13, path: "broken", syscall: "posix_spawn" });
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
