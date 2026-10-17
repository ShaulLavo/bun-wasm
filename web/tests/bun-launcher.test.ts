import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ProcessService } from "waffle";
import type { ProcessContext } from "waffle/proc";
import { bunLauncher, preview1Launcher } from "../src/bun-launcher";

// Only the launch request is under test; the real service and ABI are covered elsewhere.
interface Launch { workerUrl: string; request: Record<string, any>; cleanup?(): void; executableName?(name: string): string }
function service(launches: Launch[]): ProcessService {
  return { launchWorker(_context: unknown, options: Launch) { launches.push(options); return { terminate() {} }; } } as unknown as ProcessService;
}
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const context = { module, interruptible: false, request: { argv: ["bun", "-e", "0"], env: { A: "1" }, cwd: "/work" } } as unknown as ProcessContext;

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
  await bunLauncher(engine, { workerUrl })(context, service(launches));
  return launches[0]!;
}

for (const workerUrl of ["./worker.js", "worker.js", "https://cdn.test/assets/worker.js"]) for (const engine of ["quickjs", "jsc", "browser"] as const) {
  test(`${engine} with ordinary worker URL ${workerUrl} passes it unchanged and caches nothing`, async () => {
    const launched = await launch(engine, workerUrl);
    expect(launched.workerUrl).toBe(workerUrl);
    expect(launched.request).toMatchObject({ engine, adapter: "bun", net: null, moduleCache: null, args: ["bun", "-e", "0"], env: { A: "1", PWD: "/work" } });
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

test("executable aliasing is resolved per launch and passed through", async () => {
  const launches: Launch[] = [];
  const names = (name: string) => `x-${name}`;
  await bunLauncher("jsc", { workerUrl: "./worker.js", executableName: () => names })(context, service(launches));
  await bunLauncher("jsc", { workerUrl: "./worker.js" })(context, service(launches));
  expect(launches[0]!.executableName!("bun")).toBe("x-bun");
  expect(launches[1]!.executableName).toBeUndefined();
});
