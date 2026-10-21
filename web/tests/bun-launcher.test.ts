import { afterEach, beforeEach, expect, test } from "bun:test";
import { processRuntimeFixture } from "./process-runtime-fixture";
import { outcomeWord } from "waffle/proc/outcome";
import type { ProcessService } from "waffle";
import type { ProcessContext } from "waffle/proc";
import { bunLauncher, preview1Launcher } from "../src/bun-launcher";

// Only the launch request is under test; the real service and ABI are covered elsewhere.
interface Launch { workerUrl: string; request: Record<string, any>; cleanup?(): void; executableName?(name: string): string }
function service(launches: Launch[]): ProcessService {
  return { launchWorker(_context: unknown, options: Launch) { launches.push(options); return { terminate() {} }; } } as unknown as ProcessService;
}
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const runtime = processRuntimeFixture({});
const context = { outcome: outcomeWord(), registerRevocation: () => () => {}, module, interruptible: false, request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: { A: "1" }, cwd: "/work" } } as unknown as ProcessContext;

const location = Object.getOwnPropertyDescriptor(globalThis, "location");
const caches = Object.getOwnPropertyDescriptor(globalThis, "caches");
let deleted: string[];
beforeEach(() => {
  deleted = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/app/") });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { delete: async (name: string) => { deleted.push(name); return true; } } });
});
afterEach(() => {
  for (const [name, descriptor] of [["location", location], ["caches", caches]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

async function launch(engine: "quickjs" | "jsc" | "browser", workerUrl: string) {
  const launches: Launch[] = [];
  await bunLauncher(engine, { runtime, workerUrl })(context, service(launches));
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
  await bunLauncher("jsc", { runtime, workerUrl: "./worker.js" })(context, service(launches));
  await preview1Launcher({ workerUrl: "./worker.js" })(context, service(launches));
  expect(launches.every(launch => launch.executableName === undefined)).toBe(true);
  expect(launches[0]!.request.args[0]).toBe("bun");
  expect(launches[0]!.request.env.BUNWASM_EXEC_PATH).toBe("/bin/bun");
});

for (const engine of ["quickjs", "jsc", "browser"] as const) test(`${engine} lint/fmt selects tools without changing its process context or engine`, async () => {
  const tools = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  let loads = 0;
  const launcher = bunLauncher(engine, { runtime, workerUrl: "./worker.js", async loadTools() { loads++; return tools; } });
  for (const args of [["lint", "input.ts"], ["--cwd", "/project", "fmt", "--check", "input.ts"]]) {
    const launches: Launch[] = [];
    const toolContext = { ...context, request: { ...context.request, argv: ["bun"].concat(args) } } as ProcessContext;
    await launcher(toolContext, service(launches));
    expect(launches).toHaveLength(1);
    expect(launches[0]!.request).toMatchObject({ module: tools, engine, args: ["bun"].concat(args), env: { A: "1", PWD: "/work", BUNWASM_EXEC_PATH: "/bin/bun" } });
  }
  expect(loads).toBe(2);
  for (const args of [["run", "lint"], ["-e", "'fmt'"], ["build", "fmt"]]) {
    const launches: Launch[] = [];
    await launcher({ ...context, request: { ...context.request, argv: ["bun"].concat(args) } } as ProcessContext, service(launches));
    expect(launches[0]!.request.module).toBe(module);
  }
  expect(loads).toBe(2);
});

test("a rejected tools module prevents worker launch", async () => {
  const launches: Launch[] = [];
  const launcher = bunLauncher("browser", { runtime, workerUrl: "./__bunwasm/worker.js", async loadTools() { throw new Error("tools integrity mismatch"); } });
  const toolContext = { ...context, request: { ...context.request, argv: ["bun", "lint", "input.ts"] } } as ProcessContext;
  await expect(launcher(toolContext, service(launches))).rejects.toThrow("tools integrity mismatch");
  expect(launches).toEqual([]);
  expect(deleted).toEqual([]);
});

for (const executable of ["./bun", "../bin/bun", "/bin/../bin/bun"]) test(`admitted ${executable} has a canonical executable independent of argv[0]`, async () => {
  const launches: Launch[] = [];
  const admitted = { ...context, request: { ...context.request, executable, cwd: "/bin", argv: [executable, "-e", "0"] } };
  await bunLauncher("browser", { runtime, workerUrl: "./worker.js" })(admitted, service(launches));
  expect(launches[0]!.request.env.BUNWASM_EXEC_PATH).toBe("/bin/bun");
  expect(launches[0]!.request.args[0]).toBe(executable);
});
