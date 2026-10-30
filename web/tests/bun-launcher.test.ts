import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { processRuntimeFixture } from "./process-runtime-fixture";
import { networkPathScopeFixture, socketDirectoryFixture } from "./socket-runtime-fixture";
import { outcomeWord } from "waffle/proc/outcome";
import type { ProcessService, RuntimeProcessContext } from "waffle";
import { bunLauncher, preview1Launcher } from "../src/bun-launcher";

// Only the launch request is under test; the real service and ABI are covered elsewhere.
interface Launch { workerUrl: string; request: Record<string, any>; cleanup?(): void; executableName?(name: string): string }
const activeCleanups: Array<() => void> = [];
function service(launches: Launch[]): ProcessService {
  return { networkPathScope: networkPathScopeFixture, launchWorker(_context: unknown, options: Launch) { launches.push(options); if (options.cleanup) activeCleanups.push(options.cleanup); return { terminate() {} }; } } as unknown as ProcessService;
}
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
const context = { identity: { pid: 1, parentPid: 0, host: null }, outcome: outcomeWord(), registerRevocation: () => () => {}, module, interruptible: false, request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: { A: "1" }, cwd: "/work" } } as unknown as RuntimeProcessContext;

const location = Object.getOwnPropertyDescriptor(globalThis, "location");
const caches = Object.getOwnPropertyDescriptor(globalThis, "caches");
let deleted: string[];
beforeEach(() => {
  deleted = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/app/") });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { delete: async (name: string) => { deleted.push(name); return true; } } });
});
afterEach(() => {
  for (const cleanup of activeCleanups.splice(0)) cleanup();
  for (const [name, descriptor] of [["location", location], ["caches", caches]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

async function launch(engine: "quickjs" | "jsc" | "browser", workerUrl: string) {
  const launches: Launch[] = [];
  await bunLauncher(engine, { runtime, workerUrl, notificationWorkerUrl: "./notification-worker.js" })(context, service(launches));
  return launches[0]!;
}

for (const workerUrl of ["./worker.js", "worker.js", "https://cdn.test/assets/worker.js"]) for (const engine of ["quickjs", "jsc", "browser"] as const) {
  test(`${engine} with ordinary worker URL ${workerUrl} passes it unchanged and caches nothing`, async () => {
    const launched = await launch(engine, workerUrl);
    expect(launched.workerUrl).toBe(workerUrl);
    expect(launched.request).toMatchObject({ engine, adapter: "bun", moduleCache: null, args: ["bun", "-e", "0"], env: { A: "1", PWD: "/work", BUNWASM_EXEC_PATH: "/bin/bun" } });
    launched.cleanup!();
    expect(deleted).toEqual([]);
  });
}

for (const workerUrl of ["/__bunwasm/worker.js", "./__bunwasm/worker.js", "https://example.test/app/__bunwasm/worker.js"]) {
  test(`browser engine under scoped worker URL ${workerUrl} gets a module cache that cleanup deletes`, async () => {
    const launched = await launch("browser", workerUrl);
    expect(launched.workerUrl).toBe(workerUrl);
    const cache = launched.request.moduleCache as string;
    expect(cache).toMatch(/^bunwasm-m-[0-9a-f-]{36}$/);
    expect(deleted).toEqual([]);
    launched.cleanup!();
    expect(deleted).toEqual([cache]);
  });
  test(`quickjs and jsc under scoped worker URL ${workerUrl} get no module cache`, async () => {
    for (const engine of ["quickjs", "jsc"] as const) expect((await launch(engine, workerUrl)).request.moduleCache).toBeNull();
  });
}

test("each scoped browser launch gets its own cache", async () => {
  const first = await launch("browser", "/__bunwasm/worker.js"), second = await launch("browser", "/__bunwasm/worker.js");
  expect(first.request.moduleCache).not.toBe(second.request.moduleCache);
});

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
  const { prepareQuickjsProgram, programLinkPlan } = await import("../../src/assets");
  const { core, side } = quickjsPair();
  const prepared = await prepareQuickjsProgram(core, side);
  const launches: Launch[] = [];
  const tools = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const launcher = bunLauncher("quickjs", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js", loadTools: async () => tools });
  await launcher({ ...context, module: prepared }, service(launches));
  expect(launches[0]!.request.module).toBe(prepared);
  expect(launches[0]!.request.linkPlan).toEqual(programLinkPlan(prepared));
  expect(launches[0]!.request.linkPlan.libraries[0].source).toEqual(side);
  await launcher({ ...context, module: prepared, request: { ...context.request, argv: ["bun", "lint", "input.ts"] } }, service(launches));
  expect(launches[1]!.request.module).toBe(tools);
  expect(launches[1]!.request.linkPlan).toBeUndefined();
});

test("child launch selection retains each distinct QuickJS pair", async () => {
  const { quickjsPair } = await import("../../tests/package/quickjs-plan-fixture");
  const { prepareQuickjsProgram } = await import("../../src/assets");
  const { core, side } = quickjsPair();
  const sideB = Uint8Array.from(Array.from(side).concat([0, 2, 1, 120]));
  const first = await prepareQuickjsProgram(core, side);
  const second = await prepareQuickjsProgram(core, sideB);
  const launches: Launch[] = [];
  const launcher = bunLauncher("quickjs", { runtime, workerUrl: "./worker.js", notificationWorkerUrl: "./notification-worker.js" });
  await launcher({ ...context, module: first, identity: { ...context.identity, pid: 2, parentPid: 1 } }, service(launches));
  await launcher({ ...context, module: second, identity: { ...context.identity, pid: 3, parentPid: 1 } }, service(launches));
  expect(launches[0]!.request.linkPlan.libraries[0].source).toEqual(side);
  expect(launches[1]!.request.linkPlan.libraries[0].source).toEqual(sideB);
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
    const dispose = helper.dispose.bind(helper);
    helper.dispose = () => { events.push("helper-dispose"); dispose(); };
    return helper;
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
