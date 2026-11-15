import { expect, spyOn, test } from "bun:test";
import type { GuestLauncher } from "waffle";
import { PACKAGE_CONTINUATION } from "../../src/package-continuation-binding";
import { prepareProgram } from "../../src/assets";
import { BUN_MEMORY_GROUP_POLICY, type Engine } from "../../src/engine-kind";
import { ENGINE_BIN } from "../../src/executable-paths";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";
import { Playground } from "../src/playground/playground";
import { registerPlaygroundBun, type PlaygroundProfile } from "../src/playground/program-profile";

const { createRuntime }: typeof import("waffle") = await import(Bun.resolveSync("waffle", process.cwd()));

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
// The same relocatable-core control used by bun-launcher.test.ts.
const groupCore = new WebAssembly.Module(new Uint8Array(Array.from(empty).concat([0, 9, 8, 100, 121, 108, 105, 110, 107, 46, 48])));
const launcher: GuestLauncher = () => { throw new Error("Registration must not launch a process"); };
const providers = {
  launcher: () => launcher,
  loadModule: async () => { throw new Error("Registration must not load other engine modules"); },
};

test("playground defaults to Browser split and rejects unsupported profile selections", () => {
  expect(new Playground("")).toMatchObject({ engine: "browser", profile: "split" });
  expect(() => new Playground("?profile=shared-group")).toThrow("browser engine");
  expect(new Playground("?engine=spidermonkey&profile=shared-group")).toMatchObject({ engine: "spidermonkey", profile: "shared-group" });
  expect(() => new Playground("?engine=quickjs&profile=other")).toThrow("Unknown Bun program profile");
});

for (const engine of ["quickjs", "jsc", "spidermonkey", "browser"] as const) test(`${engine} Angular selects its worker-capable profile before loading`, () => {
  expect(new Playground(`?template=angular&engine=${engine}`).profile).toBe(engine === "browser" ? "split" : "shared-group");
  expect(new Playground(`?template=angular&engine=${engine}&profile=split`).profile).toBe("split");
  expect(new Playground(`?template=vite-react&engine=${engine}`).profile).toBe(engine === "browser" ? "split" : "shared-group");
  expect(new Playground(`?engine=${engine}`).profile).toBe("split");
  expect(new Playground("?template=angular").profileForEngine(engine)).toBe(engine === "browser" ? "split" : "shared-group");
  expect(new Playground("?template=angular&profile=split").profileForEngine(engine)).toBe("split");
});

test("Angular's engine picker can return to Browser while an explicit shared override still rejects it", () => {
  expect(new Playground("?template=angular&engine=quickjs").profileForEngine("browser")).toBe("split");
  expect(() => new Playground("?template=angular&engine=quickjs&profile=shared-group").profileForEngine("browser")).toThrow("browser engine");
});

for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) test(`${engine} prepared split aliases register only for the explicit split profile`, async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const adapter = spyOn(runtime, "registerAdapter"), programs = spyOn(runtime, "registerProgram");
  try {
    const module = await prepareProgram({ kind: engine, ...quickjsPair(engine) });
    await expect(registerPlaygroundBun({ runtime, engine, module, profile: "shared-group", ...providers })).rejects.toThrow("prepared " + engine + " core is split");
    expect(adapter).not.toHaveBeenCalled();
    expect(programs).not.toHaveBeenCalled();
    const registered = await registerPlaygroundBun({ runtime, engine, module, profile: "split", ...providers });
    expect(registered.profile).toBe("split");
    const engines: readonly Engine[] = engine === "spidermonkey" ? ["quickjs", "jsc", "browser", engine] : ["quickjs", "jsc", "browser"];
    expect(programs.mock.calls.map(([path]) => path)).toEqual([PACKAGE_CONTINUATION].concat(engines.flatMap(provider => ["bun", "bunx", "node", "nodejs"].map(name => `${ENGINE_BIN[provider]}/${name}`))));
    expect(await runtime.filesystem.readFile(`${registered.bin}/bun`)).toEqual(new TextEncoder().encode("bun-wasm registered executable\n"));
    registered.dispose();
  } finally { adapter.mockRestore(); programs.mockRestore(); await runtime.dispose(); }
});

for (const profile of ["split", "shared-group"] satisfies PlaygroundProfile[]) test(`relocatable core registration requires shared-group intent instead of ${profile} substitution`, async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const programs = spyOn(runtime, "registerProgram");
  try {
    const pending = registerPlaygroundBun({ runtime, engine: "quickjs", module: groupCore, profile, ...providers });
    if (profile === "split") {
      await expect(pending).rejects.toThrow("prepared quickjs core is shared-group");
      expect(programs).not.toHaveBeenCalled();
      return;
    }
    const registration = await pending;
    expect(registration.profile).toBe("shared-group");
    expect(programs).toHaveBeenCalledTimes(13);
    registration.dispose();
  } finally { programs.mockRestore(); await runtime.dispose(); }
});

test("Browser's ordinary prepared module registers with the split default", async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  try {
    const module = await prepareProgram({ kind: "single", core: empty });
    const registered = await registerPlaygroundBun({ runtime, engine: "browser", module, profile: "split", ...providers });
    expect(registered.profile).toBe("split");
    registered.dispose();
  } finally { await runtime.dispose(); }
});

for (const profile of ["split", "shared-group"] satisfies PlaygroundProfile[]) test(`${profile} engine paths keep their providers and lazily load matching modules`, async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const programs = spyOn(runtime, "registerProgram"), adapters = spyOn(runtime, "registerAdapter");
  const loads: Array<[Engine, PlaygroundProfile]> = [];
  const module = profile === "shared-group" ? groupCore : new WebAssembly.Module(empty);
  try {
    const registration = await registerPlaygroundBun({ runtime, engine: "quickjs", profile, module, launcher: providers.launcher,
      async loadModule(engine, memoryProfile) {
        loads.push([engine, memoryProfile]);
        return new WebAssembly.Module(empty);
      },
    });
    expect(loads).toEqual([]);
    expect(adapters.mock.calls.map(([name]) => name)).toContainAllValues(["bun:quickjs", "bun:jsc", "bun:browser"]);
    const resolved = new Map<string, WebAssembly.Module>();
    for (const [path, program] of programs.mock.calls) {
      if (path === PACKAGE_CONTINUATION) continue;
      if (!("module" in program) || typeof program.module !== "function") throw new Error("Expected a lazy Bun module");
      const engine: Engine = path.startsWith(ENGINE_BIN.quickjs) ? "quickjs" : path.startsWith(ENGINE_BIN.jsc) ? "jsc" : "browser";
      expect(program.adapter).toBe(`bun:${engine}`);
      const loaded = await program.module();
      const previous = resolved.get(engine);
      expect(loaded).toBe(previous ?? loaded);
      expect(await program.module()).toBe(loaded);
      if (engine === "quickjs") expect(loaded).toBe(module);
      else expect(loaded).not.toBe(module);
      resolved.set(engine, loaded);
    }
    expect(loads).toEqual([["jsc", profile], ["browser", "split"]]);
    registration.dispose();
  } finally { programs.mockRestore(); adapters.mockRestore(); await runtime.dispose(); }
});

test("engine provider installation preserves unrelated files and rolls back its new markers", async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const path = `${ENGINE_BIN.jsc}/bun`;
  try {
    await runtime.filesystem.mkdirp(ENGINE_BIN.jsc);
    await runtime.filesystem.writeFile(path, "owner's executable");
    const error = await registerPlaygroundBun({ runtime, engine: "browser", module: new WebAssembly.Module(empty), profile: "split", ...providers }).catch(error => error);
    expect(error).toMatchObject({ code: "BUN_WASM_EXECUTABLE_CONFLICT", path });
    expect(new TextDecoder().decode(await runtime.filesystem.readFile(path))).toBe("owner's executable");
    expect(await runtime.filesystem.lookup(`${ENGINE_BIN.quickjs}/bun`)).toBeUndefined();
    await runtime.filesystem.remove(path);
    const registered = await registerPlaygroundBun({ runtime, engine: "browser", module: new WebAssembly.Module(empty), profile: "split", ...providers });
    registered.dispose();
  } finally { await runtime.dispose(); }
});
