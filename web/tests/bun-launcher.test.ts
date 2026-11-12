import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createFilesystemConnection } from "waffle/fs";
import { workerControlFixture } from "./worker-control-fixture";
import { processRuntimeFixture } from "./process-runtime-fixture";
import { networkPathScopeFixture, socketDirectoryFixture } from "./socket-runtime-fixture";
import { outcomeWord } from "waffle/proc/outcome";
import type { ProcessService, RuntimeProcessContext } from "waffle";
import { bunLauncher, preview1Launcher } from "../src/bun-launcher";
import { createBunExecutor, type RunRequest } from "../src/bun-executor";
import { runtimeRelay } from "../src/net/relay";
import { SharedMemoryAdmissionError } from "waffle";
import { retainedMemorySnapshots } from "../src/memory-telemetry";
import * as memoryTelemetry from "../src/memory-telemetry";

// Only the launch request is under test; the real service and ABI are covered elsewhere.
interface Launch { workerUrl: string; memoryGroup?: unknown; request: Record<string, any>; network?: { connection: Record<string, unknown>; dispose(): void }; cleanup?(): void | Promise<void>; executableName?(name: string): string }
const activeCleanups: Array<() => void | Promise<void>> = [];
function service(launches: Launch[]): ProcessService {
  return { networkPathScope: networkPathScopeFixture, launchWorker(_context: unknown, options: Launch) { launches.push(options); if (options.cleanup) activeCleanups.push(options.cleanup); return { terminate() {} }; } } as unknown as ProcessService;
}
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
afterAll(() => runtime.dispose());
const context = { identity: { pid: 1, parentPid: 0, host: null }, outcome: outcomeWord(), registerRevocation: () => () => {}, module, interruptible: false, request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: { A: "1" }, cwd: "/work" } } as unknown as RuntimeProcessContext;

const location = Object.getOwnPropertyDescriptor(globalThis, "location");
const caches = Object.getOwnPropertyDescriptor(globalThis, "caches");
let deleted: string[];
beforeEach(() => {
  deleted = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/app/") });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { delete: async (name: string) => { deleted.push(name); return true; } } });
});
afterEach(async () => {
  for (const cleanup of activeCleanups.splice(0)) await cleanup();
  for (const [name, descriptor] of [["location", location], ["caches", caches]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

async function launch(engine: "quickjs" | "jsc" | "browser", workerUrl: string) {
  const launches: Launch[] = [];
  await bunLauncher(engine, { runtime, workerUrl, notificationWorkerUrl: "./notification-worker.js" })(context, service(launches));
  return launches[0]!;
}

// Guest modules never depend on the worker's URL or service-worker scope: no launch makes or
// deletes a module cache.
const workerUrls = ["./worker.js", "worker.js", "https://cdn.test/assets/worker.js", "/__bunwasm/worker.js", "./__bunwasm/worker.js", "https://example.test/app/__bunwasm/worker.js"];
for (const workerUrl of workerUrls) for (const engine of ["quickjs", "jsc", "browser"] as const) {
  test(`${engine} with worker URL ${workerUrl} passes it unchanged and caches nothing`, async () => {
    const launched = await launch(engine, workerUrl);
    expect(launched.workerUrl).toBe(workerUrl);
    expect(launched.request).toMatchObject({ engine, adapter: "bun", args: ["bun", "-e", "0"], env: { A: "1", PWD: "/work", BUNWASM_EXEC_PATH: "/bin/bun" } });
    expect(launched.request).not.toHaveProperty("moduleCache");
    launched.cleanup!();
    expect(deleted).toEqual([]);
  });
}

test("browser adapter launches carry a runtime-owned DNS channel", async () => {
  const browser = await launch("browser", "./worker.js");
  expect(browser.request.lookupChannel).toMatch(/^bun-wasm-dns-[0-9a-f-]{36}$/);
  expect((await launch("quickjs", "./worker.js")).request.lookupChannel).toBeUndefined();
  expect((await launch("jsc", "./worker.js")).request.lookupChannel).toBeUndefined();
});

for (const [workerUrl, expected] of [
  ["./worker.js", "https://example.test/app/preview1-worker.js"],
  ["/assets/worker.js", "https://example.test/assets/preview1-worker.js"],
  ["https://cdn.test/a/worker.js", "https://cdn.test/a/preview1-worker.js"],
] as const) test(`preview1 worker is a sibling of ${workerUrl}`, async () => {
  const launches: Launch[] = [];
  await preview1Launcher({ workerUrl })(context, service(launches));
  expect(launches[0]!.workerUrl).toBe(expected);
  expect(launches[0]!.request).toMatchObject({ module, args: ["bun", "-e", "0"], env: { A: "1", PWD: "/work" } });
});

// A group core is relocatable: one `dylink.0` custom section. Only the typed worker field of the
// spawn request joins the parent's group; environment markers never do.
const groupCore = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, 9, 8, 100, 121, 108, 105, 110, 107, 46, 48]));
const workerMarkers = { BUNWASM_WORKER_CONTROL: "{}", BUNWASM_WORKER_INIT: "{}" };

for (const inherited of [false, true]) test(`launch refusal retains its native cause and pre-cleanup snapshots for ${inherited ? "inherit" : "new"}`, async () => {
  const nativeCause = new RangeError("native backing refusal");
  const error = new SharedMemoryAdmissionError({ kind: "platform", label: "memory-group", cause: nativeCause });
  Object.defineProperty(error, "cause", { value: new Error("different outer cause") });
  let cleaned = false;
  const calls: string[] = [];
  const failed = { ...context, pid: 71, parentPid: 11, job: 9, module: groupCore,
    request: { ...context.request, worker: inherited ? { memoryLimitMb: 64 } : undefined } };
  const owner = processRuntimeFixture({ directoryHandle: async () => ({ handle: 1, release() { calls.push("cleanup"); cleaned = true; } }) }, {
    sharedMemory: {
      snapshot() {
        calls.push("ledger"); expect(cleaned).toBe(false);
        return { platform: { kind: "unbounded", source: "default" }, budgetBytes: null, reservedBytes: 65536, availableBytes: null, awaitingReleaseBytes: 0, debtBytes: 0, effectiveBudgetBytes: null, contradictions: [], sharedGuests: [], holders: [] };
      },
      check() { throw Error("not used"); },
    },
  });
  const launcherService = Object.assign(service([]), {
    memoryGroups() { calls.push("groups"); expect(cleaned).toBe(false); return []; },
    workerMemory() { calls.push("workers"); expect(cleaned).toBe(false); return [{ pid: 71, parentPid: 11, rootPid: 10, job: 9, directory: "admitted-directory", bytes: null }]; },
    launchWorker(_context: unknown, options: Launch) { calls.push("launch"); expect(options.memoryGroup).toBe(inherited ? "inherit" : "new"); throw error; },
  });
  try {
    await expect(bunLauncher("quickjs", { runtime: owner, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(failed, launcherService)).rejects.toBe(error);
    const snapshot = retainedMemorySnapshots().find(value => value.launchFailures?.some(fact => fact.error.message === error.message && fact.memoryGroup === (inherited ? "inherit" : "new")));
    expect(snapshot).toMatchObject({ terminal: true, engine: "quickjs" });
    const fact = snapshot?.launchFailures?.[0];
    expect(fact).toMatchObject({ memoryGroup: inherited ? "inherit" : "new", attemptScope: "bun-launcher module instance",
      process: { pid: 71, parentPid: 11, rootPid: 10, job: 9, directory: "admitted-directory", executable: "/bin/bun", cwd: "/work" },
      refusal: { kind: "platform", label: "memory-group", cause: { name: "RangeError", message: "native backing refusal", stack: nativeCause.stack } },
      groups: { availability: "observed", rowCount: 0, rows: [], rowsTruncated: false },
      workers: { availability: "observed", rowCount: 1 }, ledger: { availability: "observed", totals: { reservedBytes: 65536 } }, cleanupError: null });
    expect(snapshot?.commandId).toMatch(/:9$/);
    expect(calls).toEqual(["launch", "groups", "workers", "ledger", "cleanup"]);
    expect(fact!.groups.sampleStartedAt).toBeGreaterThanOrEqual(fact!.time);
    expect(fact!.ledger.sampleEndedAt).toBeGreaterThanOrEqual(fact!.workers.sampleEndedAt);
  } finally { await owner.dispose(); }
});

test("launch observation failures preserve the cleanup error and the original launch fact", async () => {
  const launchError = new Error("original launch refusal with cleanup failure");
  const cleanupError = new Error("original cleanup failure");
  const owner = processRuntimeFixture({ directoryHandle: async () => ({ handle: 1, release() { throw cleanupError; } }) });
  const launcherService = Object.assign(service([]), {
    memoryGroups() { throw Error("group diagnostic unavailable"); },
    workerMemory() { throw Error("worker diagnostic unavailable"); },
    launchWorker() { throw launchError; },
  });
  try {
    await expect(bunLauncher("quickjs", { runtime: owner, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })({ ...context, pid: 72, parentPid: 11, job: 10 }, launcherService)).rejects.toBe(cleanupError);
    const snapshot = retainedMemorySnapshots().find(value => value.launchFailures?.some(fact => fact.error.message === launchError.message));
    expect(snapshot).toMatchObject({ terminal: true, launchFailures: [{ error: { message: launchError.message }, cleanupError: { message: cleanupError.message },
      groups: { availability: "unavailable", rowCount: null }, workers: { availability: "unavailable", rowCount: null }, ledger: { availability: "unavailable" } }] });
  } finally { await owner.dispose(); }
});

test("a throwing diagnostic publication preserves launch identity and still cleans up", async () => {
  const launchError = new Error("original refusal despite failed publication");
  let cleaned = false;
  let publications = 0;
  const owner = processRuntimeFixture({ directoryHandle: async () => ({ handle: 1, release() { cleaned = true; } }) });
  const publication = spyOn(memoryTelemetry, "recordLaunchFailure").mockImplementation(() => { publications++; throw Error("publication failed"); });
  try {
    const launcherService = Object.assign(service([]), { launchWorker() { throw launchError; } });
    await expect(bunLauncher("quickjs", { runtime: owner, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(context, launcherService)).rejects.toBe(launchError);
    expect(publications).toBe(1);
    expect(cleaned).toBe(true);
  } finally { publication.mockRestore(); await owner.dispose(); }
});

test("launch observation preserves call argument getter order without reading them again", async () => {
  const calls: string[] = [];
  const launchError = new Error("getter order refusal");
  const request = { ...context.request };
  Object.defineProperties(request, {
    worker: { get() { calls.push("worker"); return undefined; } },
    cwd: { get() { calls.push("cwd"); return "/work"; } },
    executable: { get() { calls.push("executable"); return "/bin/bun"; } },
  });
  const launcherService = service([]);
  Object.defineProperty(launcherService, "launchWorker", { get() { calls.push("method"); return () => { calls.push("launch"); throw launchError; }; } });
  const owner = processRuntimeFixture({ directoryHandle: async () => ({ handle: 1, release() { calls.push("cleanup"); } }) });
  try {
    const launcher = bunLauncher("quickjs", { runtime: owner,
      get workerUrl() { calls.push("workerUrl"); return "./worker.js"; },
      get notificationWorkerUrl() { calls.push("notificationWorkerUrl"); return "./notification-worker.js"; },
    });
    await expect(launcher({ ...context, module: groupCore, request }, launcherService)).rejects.toBe(launchError);
    expect(calls).toEqual(["method", "workerUrl", "notificationWorkerUrl", "worker", "cwd", "executable", "cwd", "launch", "cleanup"]);
  } finally { await owner.dispose(); }
});
for (const { name, core, request, expected } of [
  { name: "a split core", core: module, request: {}, expected: undefined },
  { name: "a split core started as a guest thread", core: module, request: { worker: {} }, expected: undefined },
  { name: "a group core", core: groupCore, request: {}, expected: "new" },
  { name: "a group core started as a guest thread", core: groupCore, request: { worker: { memoryLimitMb: 64 } }, expected: "inherit" },
  { name: "a group core with forged worker environment markers", core: groupCore, request: { env: workerMarkers }, expected: "new" },
]) test(`${name} launches with memory group ${String(expected)}`, async () => {
  const launches: Launch[] = [];
  const spawned = { ...context, module: core, request: { ...context.request, ...request } };
  await bunLauncher("quickjs", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(spawned, service(launches));
  expect(launches[0]!.memoryGroup).toBe(expected);
});

test("launchers do not add hidden executable rewriting", async () => {
  const launches: Launch[] = [];
  await bunLauncher("jsc", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(context, service(launches));
  await preview1Launcher({ workerUrl: "./worker.js" })(context, service(launches));
  expect(launches.every(launch => launch.executableName === undefined)).toBe(true);
  expect(launches[0]!.request.args[0]).toBe("bun");
  expect(launches[0]!.request.env.BUNWASM_EXEC_PATH).toBe("/bin/bun");
});

for (const engine of ["quickjs", "jsc", "browser"] as const) test(`${engine} lint/fmt selects tools without changing its process context or engine`, async () => {
  const tools = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  let loads = 0;
  const launcher = bunLauncher(engine, { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js", async loadTools() { loads++; return tools; } });
  for (const args of [["lint", "input.ts"], ["--cwd", "/project", "fmt", "--check", "input.ts"]]) {
    const launches: Launch[] = [];
    const toolContext = { ...context, request: { ...context.request, argv: ["bun"].concat(args) } };
    await launcher(toolContext, service(launches));
    expect(launches).toHaveLength(1);
    expect(launches[0]!.request).toMatchObject({ module: tools, engine, args: ["bun"].concat(args), env: { A: "1", PWD: "/work", BUNWASM_EXEC_PATH: "/bin/bun" } });
  }
  expect(loads).toBe(2);
  for (const args of [["run", "lint"], ["-e", "'fmt'"], ["build", "fmt"]]) {
    const launches: Launch[] = [];
    await launcher({ ...context, request: { ...context.request, argv: ["bun"].concat(args) } }, service(launches));
    expect(launches[0]!.request.module).toBe(module);
  }
  expect(loads).toBe(2);
});

test("a rejected tools module prevents worker launch", async () => {
  const launches: Launch[] = [];
  const launcher = bunLauncher("browser", { runtime, workerUrl: "./__bunwasm/worker.js", notificationWorkerUrl: "./notification-worker.js", async loadTools() { throw new Error("tools integrity mismatch"); } });
  const toolContext = { ...context, request: { ...context.request, argv: ["bun", "lint", "input.ts"] } };
  await expect(launcher(toolContext, service(launches))).rejects.toThrow("tools integrity mismatch");
  expect(launches).toEqual([]);
  expect(deleted).toEqual([]);
});

for (const executable of ["./bun", "../bin/bun", "/bin/../bin/bun"]) test(`admitted ${executable} has a canonical executable independent of argv[0]`, async () => {
  const launches: Launch[] = [];
  const admitted = { ...context, request: { ...context.request, executable, cwd: "/bin", argv: [executable, "-e", "0"] } };
  await bunLauncher("browser", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(admitted, service(launches));
  expect(launches[0]!.request.env.BUNWASM_EXEC_PATH).toBe("/bin/bun");
  expect(launches[0]!.request.args[0]).toBe(executable);
});

test("the ordinary launcher forwards the prepared pair but keeps tools single-module", async () => {
  const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
  const { prepareProgram, prepareQuickjsProgram, programMetadata } = await import("../../src/assets");
  const { core, side } = quickjsPair("quickjs", 4);
  const prepared = await prepareQuickjsProgram(core, side);
  const launches: Launch[] = [];
  const tools = await prepareProgram({ kind: "single", core: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 1, 8]) });
  const launcher = bunLauncher("quickjs", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js", loadTools: async () => tools });
  await launcher({ ...context, module: prepared }, service(launches));
  expect(launches[0]!.request.module).toBe(prepared);
  expect(launches[0]!.request.linkPlan).toEqual(programMetadata(prepared).linkPlan);
  expect(launches[0]!.request.memoryLimitBytes).toBe(programMetadata(prepared).memoryLimitBytes);
  expect(launches[0]!.request.memoryLimitBytes).toBe(4 * 65536);
  await launcher({ ...context, module: prepared, request: { ...context.request, argv: ["bun", "lint", "input.ts"] } }, service(launches));
  expect(launches[1]!.request.module).toBe(tools);
  expect(launches[1]!.request.linkPlan).toBeUndefined();
  expect(launches[1]!.request.memoryLimitBytes).toBe(8 * 65536);
});

test("child launch selection retains each distinct QuickJS pair", async () => {
  const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
  const { prepareQuickjsProgram, programMetadata } = await import("../../src/assets");
  const { core, side } = quickjsPair();
  const sideB = Uint8Array.from(Array.from(side).concat([0, 2, 1, 120]));
  const first = await prepareQuickjsProgram(core, side);
  const second = await prepareQuickjsProgram(core, sideB);
  const launches: Launch[] = [];
  const launcher = bunLauncher("quickjs", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" });
  await launcher({ ...context, module: first, identity: { ...context.identity, pid: 2, parentPid: 1 } }, service(launches));
  await launcher({ ...context, module: second, identity: { ...context.identity, pid: 3, parentPid: 1 } }, service(launches));
  expect(launches[0]!.request.linkPlan).toBe(programMetadata(first).linkPlan);
  expect(launches[1]!.request.linkPlan).toBe(programMetadata(second).linkPlan);
  expect(launches[0]!.request.module).not.toBe(launches[1]!.request.module);
});


for (const phase of ["success", "scope failure", "helper failure", "launch failure"] as const) test(`socket directory ownership survives ${phase}`, async () => {
  const events: string[] = [];
  const scopedRuntime = processRuntimeFixture({
    async directoryHandle() { return { handle: 19, release() { events.push("root-release"); } }; },
  });
  const network = await scopedRuntime.network();
  const make = network.createHelper.bind(network);
  const create = spyOn(network, "createHelper").mockImplementation(options => {
    if (phase === "helper failure") throw new Error(phase);
    const helper = make(options);
    return { ...helper, dispose() { events.push("helper-dispose"); helper.dispose(); } };
  });
  const launches: Launch[] = [];
  const scope = networkPathScopeFixture(context, 19);
  const launcherService = Object.assign(service(launches), {
    networkPathScope(actual: unknown, directory: number) {
      expect(actual).toBe(context);
      expect(directory).toBe(19);
      if (phase === "scope failure") throw new Error(phase);
      return scope;
    },
  });
  if (phase === "launch failure") launcherService.launchWorker = () => { throw new Error(phase); };
  try {
    const launching = bunLauncher("quickjs", { runtime: scopedRuntime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(context, launcherService);
    if (phase !== "success") await expect(launching).rejects.toThrow(phase);
    else { await launching; launches[0]!.cleanup!(); launches[0]!.cleanup!(); }
    expect(events).toEqual(phase === "scope failure" || phase === "helper failure" ? ["root-release"] : ["helper-dispose", "root-release"]);
    if (phase !== "scope failure") expect(create.mock.calls[0]?.[0]).toMatchObject({ pathScope: scope });
  } finally { create.mockRestore(); await scopedRuntime.dispose(); }
});

test("revocation while awaiting a directory lease releases it without creating a helper", async () => {
  const directory = Promise.withResolvers<{ handle: number; release(): void }>();
  const requested = Promise.withResolvers<void>();
  const events: string[] = [];
  const scopedRuntime = processRuntimeFixture({
    directoryHandle() { requested.resolve(); return directory.promise; },
  });
  const network = await scopedRuntime.network();
  const create = spyOn(network, "createHelper");
  let revoke = () => {};
  const revocable = { ...context, registerRevocation(hook: () => void) { revoke = hook; return () => {}; } };
  try {
    const launching = bunLauncher("quickjs", { runtime: scopedRuntime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(revocable, service([]));
    await requested.promise;
    revoke();
    directory.resolve({ handle: 19, release() { events.push("root-release"); } });
    await expect(launching).rejects.toThrow("revoked");
    expect(create).not.toHaveBeenCalled();
    expect(events).toEqual(["root-release"]);
  } finally { create.mockRestore(); await scopedRuntime.dispose(); }
});


test("relay opt-in stays page-owned and keeps token access lazy", async () => {
  const scopedRuntime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const network = await scopedRuntime.network();
  const create = spyOn(network, "createHelper");
  const tokenCalls: string[] = [];
  const launches: Launch[] = [];
  const relay = {
    endpoint: "http://127.0.0.1:8787/",
    getToken() { tokenCalls.push("guest must not call this"); return "secret"; },
    carriers: ["websocket"] as const,
  };
  try {
    await bunLauncher("quickjs", {
      runtime: scopedRuntime,
      workerUrl: "./worker.js",
      notificationWorkerUrl: "./notification-worker.js",
      network: { relay },
    })(context, service(launches));
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0]?.[0];
    if (!options) throw new Error("network helper options were not captured");
    expect(options.connect).toBeFunction();
    expect(tokenCalls).toEqual([]);
    expect(launches[0]!.request).not.toHaveProperty("relay");
    expect(launches[0]!.request).not.toHaveProperty("connect");
    await launches[0]!.cleanup?.();
    expect(tokenCalls).toEqual([]);
  } finally {
    create.mockRestore();
    await scopedRuntime.dispose();
  }
});

test("relay client is shared by launches on one runtime", async () => {
  const scopedRuntime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const relay = {
    endpoint: "http://127.0.0.1:8787/",
    getToken: () => "unused",
    carriers: ["websocket"] as const,
  };
  try {
    const first = await runtimeRelay(scopedRuntime, relay);
    const second = await runtimeRelay(scopedRuntime, relay);
    expect(first).toBe(second);
  } finally {
    await scopedRuntime.dispose();
  }
});

test("preview1 launcher transfers only cloneable socket metadata and keeps owner disposal page-side", async () => {
  const scopedRuntime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const launches: Launch[] = [];
  const sockets = [{ fd: 3, socket: { connect: { host: "echo.example", port: 4321 } } }] as const;
  try {
    await preview1Launcher({
      runtime: scopedRuntime,
      workerUrl: "./worker.js",
      preview1: { sockets },
    })(context, service(launches));
    const owner = launches[0]!.network;
    expect(owner).toBeDefined();
    expect(owner!.connection.ring).toBeInstanceOf(SharedArrayBuffer);
    expect(owner!.connection.port).toBeInstanceOf(MessagePort);
    expect(owner!.connection.sockets).toEqual(sockets);
    expect(owner!.connection).not.toHaveProperty("connect");
    expect(owner!.connection).not.toHaveProperty("relay");
    owner!.dispose();
  } finally {
    await scopedRuntime.dispose();
  }
});

test("empty preview1 socket bindings stay lazy", async () => {
  const scopedRuntime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const network = spyOn(scopedRuntime, "network");
  const launches: Launch[] = [];
  try {
    await preview1Launcher({ runtime: scopedRuntime, workerUrl: "./worker.js" })(context, service(launches));
    expect(network).not.toHaveBeenCalled();
    expect(launches[0]!.network).toBeUndefined();
  } finally {
    network.mockRestore();
    await scopedRuntime.dispose();
  }
});


for (const withRelay of [false, true]) test(`broker preview1 preserves the explicit connector with relay ${withRelay}`, async () => {
  const scopedRuntime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const network = await scopedRuntime.network();
  const create = spyOn(network, "createHelper");
  const launches: Launch[] = [];
  const connect = async () => { throw new Error("setup must not open a connection"); };
  const relay = withRelay ? {
    endpoint: "http://127.0.0.1:8787/",
    getToken() { throw new Error("setup must not request a token"); },
    carriers: ["websocket"] as const,
  } : undefined;
  try {
    await preview1Launcher({
      runtime: scopedRuntime,
      workerUrl: "./worker.js",
      network: { connect, relay },
      preview1: { sockets: [{ fd: 3, socket: { connect: { host: "echo.example", port: 4321 } } }] },
    })(context, service(launches));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].connect).toBe(connect);
    expect(launches[0]?.network?.connection).not.toHaveProperty("connect");
    expect(launches[0]?.network?.connection).not.toHaveProperty("relay");
  } finally {
    launches[0]?.network?.dispose();
    create.mockRestore();
    await scopedRuntime.dispose();
  }
});

const safariAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15";

for (const child of [false, true]) test(`Safari page observations reach the ${child ? "spawned" : "root"} executor without WorkerNavigator touch support`, async () => {
  const control = await workerControlFixture();
  const connection = createFilesystemConnection();
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const pageHost = { platform: "MacIntel", vendor: "Apple Computer, Inc.", maxTouchPoints: 0 };
  const capture = spyOn(globalThis, "Error").mockReturnValue(Object.assign(new Error(), { stack: "createBunExecutor@https://example.test/worker.js:1:1" }));
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { ...pageHost, userAgent: safariAgent } });
    const launches: Launch[] = [];
    const spawned = { ...context, identity: { ...context.identity, pid: child ? 2 : 1, parentPid: child ? 1 : 0 } };
    await bunLauncher("quickjs", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" })(spawned, service(launches));
    const launched = launches[0]!;
    expect(launched.request.stackHost).toEqual(pageHost);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: safariAgent, platform: "MacIntel" } });
    const request: RunRequest = {
      engine: "quickjs", module: launched.request.module, args: launched.request.args, env: launched.request.env,
      trace: false, net: null, stackHost: launched.request.stackHost,
      controlGrant: control.grant, filesystem: connection.client,
    };
    expect(createBunExecutor(request).env?.(request)?.BUN_WASM_STACK_KIB).toBe("36");
    for (const override of ["", "32", "64", "invalid"]) {
      const explicit = { ...request, env: { ...request.env, BUN_WASM_STACK_KIB: override } };
      expect(createBunExecutor(explicit).env?.(explicit)?.BUN_WASM_STACK_KIB).toBe(override);
    }
    const unknown = { ...request, stackHost: undefined };
    expect(createBunExecutor(unknown).env?.(unknown)?.BUN_WASM_STACK_KIB).toBe("32");
    const ipad = { ...request, stackHost: { ...pageHost, maxTouchPoints: 5 } };
    expect(createBunExecutor(ipad).env?.(ipad)?.BUN_WASM_STACK_KIB).toBe("32");
  } finally {
    capture.mockRestore();
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    connection.client.port.close();
    connection.server.port.close();
    await control.dispose();
  }
});
