import { prepareProgram } from "../../src/assets.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";
import { expect, test } from "bun:test";
import { installBunAdapters } from "../../src/bun-adapter";
import { ENGINE_BIN, engineEnvironment } from "../../src/executable-paths";
import { processRuntimeFixture } from "../../web/tests/process-runtime-fixture";
import { startRun } from "../../web/src/runner";
import { MemoryBackend } from "waffle/fs/backend";
import { FilesystemService } from "waffle/fs/service";
import { connectFilesystemIdentity, createFilesystemIdentity, revokeFilesystem, type FilesystemIdentity } from "waffle/fs/protocol";
import { WorkerProcessClient, createWorkerProcessTransport } from "waffle/proc/worker-client";
import { DescriptorTable } from "waffle/core/descriptors";

const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
const workerUrl = new URL("../../web/tests/fixtures/telemetry-environment-worker.ts", import.meta.url).href;

function stringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === "string");
}

function observation(line: string) {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("env" in value) || !stringRecord(value.env)
    || !("pid" in value) || typeof value.pid !== "number" || !("parentPid" in value) || typeof value.parentPid !== "number") {
    throw new TypeError("invalid worker environment observation");
  }
  return { env: value.env, pid: value.pid, parentPid: value.parentPid };
}

function environmentRuntime() {
  const identity = createFilesystemIdentity();
  const connections: ReturnType<typeof connectFilesystemIdentity>[] = [];
  const backend = new MemoryBackend();
  const filesystem = new FilesystemService(backend);
  const connect = (identity: FilesystemIdentity) => {
    const connection = connectFilesystemIdentity(identity);
    connections.push(connection);
    filesystem.connect(connection.server);
    return connection.client;
  };
  const runtime = processRuntimeFixture({ fork: () => connect(createFilesystemIdentity(identity)), connect, revoke: revokeFilesystem, reap() {}, async quiesce() {} });
  backend.execute = (operation, args, data) => {
    const path = args[0];
    if (typeof path !== "string") throw new TypeError("filesystem path required");
    switch (operation) {
      case "lookup": return runtime.filesystem.lookup(path);
      case "readFile": return runtime.filesystem.readFile(path);
      case "mkdirp": return runtime.filesystem.mkdirp(path);
      case "remove": return runtime.filesystem.remove(path);
      case "writeFile": return runtime.filesystem.writeFile(path, data);
      default: throw new Error(`unexpected filesystem operation ${operation}`);
    }
  };
  return { runtime, identity, async dispose() {
    try { await runtime.dispose(); }
    finally {
      filesystem.dispose();
      for (const connection of connections) { connection.server.port.close(); connection.client.port.close(); }
    }
  } };
}

async function admittedEnvironment(env: Record<string, string>, engine: "browser" | "quickjs" | "jsc", spawnChild = false) {
  const fixture = environmentRuntime();
  const descriptors = new DescriptorTable();
  const chunks: Uint8Array[] = [];
  const pending: Promise<void>[] = [];
  let installation: Awaited<ReturnType<typeof installBunAdapters>> | undefined;
  try {
    const selected = engine === "browser" ? module : await prepareProgram({ kind: engine, ...quickjsPair(engine) });
    installation = await installBunAdapters(fixture.runtime, { engine, module: selected, workerUrl });
    const service = await fixture.runtime.processes();
    const pid = fixture.runtime.identities.pid();
    const transport = createWorkerProcessTransport({ pid, job: fixture.runtime.identities.job(), identity: fixture.runtime.identities.buffer });
    transport.data = { filesystem: createFilesystemIdentity(fixture.identity) };
    await service.adoptRuntimeRoot(transport, { output(_fd, data) { chunks.push(data); } });
    const rootData = transport.data;
    if (!rootData || typeof rootData !== "object" || !("pipeRegistry" in rootData)) throw new Error("root pipe registry required");
    const client = new WorkerProcessClient({ transport, descriptors,
      codec: { export() { throw new Error("unexpected descriptor export"); }, import() { throw new Error("unexpected descriptor import"); }, discard() {} },
      postMessage(message) { pending.push(service.runtimeMessage(message, pid)); },
      prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(fixture.identity), pipeRegistry: rootData.pipeRegistry } }),
    });
    const child = client.spawn(pid, { executable: `${ENGINE_BIN[engine]}/bun`, argv: ["bun", spawnChild ? "--spawn-child" : "--environment-control"], cwd: "/project", env, job: -1, fds: [] });
    await Promise.all(pending);
    const supervisor = await service.ready();
    const result = await supervisor.waitForExit(pid, child);
    expect(result.status).toBe(0);
    const received = Buffer.concat(chunks).toString().trim().split("\n").map(observation);
    expect(received).toHaveLength(spawnChild ? 2 : 1);
    const [parent, descendant] = received;
    if (!parent) throw new Error("worker environment observation missing");
    expect(parent).toMatchObject({ pid: child, parentPid: pid });
    if (spawnChild) {
      expect(descendant?.parentPid).toBe(child);
      expect(descendant?.env).toEqual(parent.env);
    }
    return parent.env;
  } finally {
    installation?.dispose();
    descriptors.dispose();
    await fixture.dispose();
  }
}

function restoreLocation(location: PropertyDescriptor | undefined) {
  if (location) Object.defineProperty(globalThis, "location", location);
  else Reflect.deleteProperty(globalThis, "location");
}

async function rootEnvironment(env: Record<string, string>, adapter: "bun" | "preview1") {
  const fixture = environmentRuntime();
  const NativeWorker = globalThis.Worker;
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  const chunks: Uint8Array[] = [];
  let run: ReturnType<typeof startRun> | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(_url: string | URL, options?: WorkerOptions) { super(workerUrl, options); }
  };
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  try {
    run = startRun({ engine: "browser", adapter, module, args: ["--environment-control"], env, runtime: fixture.runtime, moduleScope: false }, { stdout(data) { chunks.push(data); }, stderr() {} });
    expect(await run.done).toEqual({ code: 0 });
    return observation(Buffer.concat(chunks).toString().trim()).env;
  } finally {
    run?.kill(9);
    try { await fixture.dispose(); }
    finally {
      globalThis.Worker = NativeWorker;
      restoreLocation(location);
    }
  }
}

test("normal Bun root requests receive the default at the native worker boundary", async () => {
  const caller = Object.freeze({ PATH: "/tools:/bin", PWD: "/project", BUNWASM_EXEC_PATH: "/caller/bun" });
  expect(await rootEnvironment(caller, "bun")).toEqual({ PATH: "/bin:/tools:/bin", PWD: "/project", BUNWASM_EXEC_PATH: "/bin/bun", NEXT_TELEMETRY_DISABLED: "1" });
  expect(caller).toEqual({ PATH: "/tools:/bin", PWD: "/project", BUNWASM_EXEC_PATH: "/caller/bun" });
});

test("preview1 root requests preserve their environment without Bun defaults", async () => {
  const environments: Record<string, string>[] = [{}, { NEXT_TELEMETRY_DISABLED: "0" }, { NEXT_TELEMETRY_DISABLED: "" }];
  for (const env of environments) {
    const caller = Object.freeze({ PATH: "/tools", PWD: "/project", CUSTOM: "kept", ...env });
    expect(await rootEnvironment(caller, "preview1")).toEqual({ ...caller, PATH: "/bin:/tools", BUNWASM_EXEC_PATH: "/bin/bun" });
    expect(caller).toEqual({ PATH: "/tools", PWD: "/project", CUSTOM: "kept", ...env });
  }
});

for (const value of ["0", "", "caller-choice"]) test(`Bun root requests preserve explicit telemetry ${JSON.stringify(value)}`, async () => {
  const caller = Object.freeze({ NEXT_TELEMETRY_DISABLED: value, PATH: "/bin", PWD: "/project" });
  expect(await rootEnvironment(caller, "bun")).toEqual({ ...caller, BUNWASM_EXEC_PATH: "/bin/bun" });
});

for (const engine of ["browser", "quickjs", "jsc"] as const) {
  test(`${engine} engine environment preserves its PATH-only contract`, () => {
    const caller = Object.freeze({ PATH: "/tools:/bin", CUSTOM: "kept" });
    const result = engineEnvironment(engine, caller);
    expect(result).toEqual({ PATH: `${ENGINE_BIN[engine]}:/tools:/bin`, CUSTOM: "kept" });
    expect(caller).toEqual({ PATH: "/tools:/bin", CUSTOM: "kept" });
  });

  test(`${engine} public package adapter defaults telemetry across actual admitted worker transport`, async () => {
    const caller = Object.freeze({ PATH: "/caller-only", PWD: "/caller", BUNWASM_EXEC_PATH: "/caller/bun", CUSTOM: "kept" });
    const received = await admittedEnvironment(caller, engine, true);
    expect(received).toEqual({ PATH: "/caller-only", PWD: "/project", BUNWASM_EXEC_PATH: `${ENGINE_BIN[engine]}/bun`, CUSTOM: "kept", NEXT_TELEMETRY_DISABLED: "1" });
    expect(caller).toEqual({ PATH: "/caller-only", PWD: "/caller", BUNWASM_EXEC_PATH: "/caller/bun", CUSTOM: "kept" });
  });

  for (const value of ["0", "", "caller-choice"]) test(`${engine} explicit telemetry value ${JSON.stringify(value)} survives root and package launch`, async () => {
    const caller = Object.freeze({ NEXT_TELEMETRY_DISABLED: value, PATH: "", CUSTOM: "kept" });
    const root = engineEnvironment(engine, caller);
    expect(root.NEXT_TELEMETRY_DISABLED).toBe(value);
    expect(root.PATH).toBe(`${ENGINE_BIN[engine]}:`);
    expect((await admittedEnvironment(caller, engine)).NEXT_TELEMETRY_DISABLED).toBe(value);
    expect(caller).toEqual({ NEXT_TELEMETRY_DISABLED: value, PATH: "", CUSTOM: "kept" });
  });
}
