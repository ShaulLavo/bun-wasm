import { expect, spyOn, test } from "bun:test";
import type { GuestLauncher } from "waffle";
import { prepareProgram } from "../../src/assets";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture";
import { Playground } from "../src/playground/playground";
import { registerPlaygroundBun, type PlaygroundProfile } from "../src/playground/program-profile";

const { createRuntime }: typeof import("waffle") = await import(Bun.resolveSync("waffle", process.cwd()));

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
// The same relocatable-core control used by bun-launcher.test.ts.
const groupCore = new WebAssembly.Module(new Uint8Array(Array.from(empty).concat([0, 9, 8, 100, 121, 108, 105, 110, 107, 46, 48])));
const launcher: GuestLauncher = () => { throw new Error("Registration must not launch a process"); };

test("playground defaults to Browser split and rejects unsupported profile selections", () => {
  expect(new Playground("")).toMatchObject({ engine: "browser", profile: "split" });
  expect(() => new Playground("?profile=shared-group")).toThrow("browser engine");
  expect(() => new Playground("?engine=spidermonkey&profile=shared-group")).toThrow("spidermonkey engine");
  expect(() => new Playground("?engine=quickjs&profile=other")).toThrow("Unknown Bun program profile");
});

for (const engine of ["quickjs", "jsc"] as const) test(`${engine} prepared split aliases register only for the explicit split profile`, async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const adapter = spyOn(runtime, "registerAdapter"), programs = spyOn(runtime, "registerProgram");
  try {
    const module = await prepareProgram({ kind: engine, ...quickjsPair(engine) });
    await expect(registerPlaygroundBun({ runtime, engine, module, profile: "shared-group", launcher })).rejects.toThrow("prepared " + engine + " core is split");
    expect(adapter).not.toHaveBeenCalled();
    expect(programs).not.toHaveBeenCalled();
    const registered = await registerPlaygroundBun({ runtime, engine, module, profile: "split", launcher });
    expect(registered.profile).toBe("split");
    expect(programs.mock.calls.map(([path]) => path)).toEqual(["bun", "node", "nodejs"].map(name => `${registered.bin}/${name}`));
    expect(await runtime.filesystem.readFile(`${registered.bin}/bun`)).toEqual(new TextEncoder().encode("bun-wasm registered executable\n"));
    registered.dispose();
  } finally { adapter.mockRestore(); programs.mockRestore(); await runtime.dispose(); }
});

for (const profile of ["split", "shared-group"] satisfies PlaygroundProfile[]) test(`relocatable core registration requires shared-group intent instead of ${profile} substitution`, async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const programs = spyOn(runtime, "registerProgram");
  try {
    const pending = registerPlaygroundBun({ runtime, engine: "quickjs", module: groupCore, profile, launcher });
    if (profile === "split") {
      await expect(pending).rejects.toThrow("prepared quickjs core is shared-group");
      expect(programs).not.toHaveBeenCalled();
      return;
    }
    const registration = await pending;
    expect(registration.profile).toBe("shared-group");
    expect(programs).toHaveBeenCalledTimes(3);
    registration.dispose();
  } finally { programs.mockRestore(); await runtime.dispose(); }
});

test("Browser's ordinary prepared module registers with the split default", async () => {
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  try {
    const module = await prepareProgram({ kind: "single", core: empty });
    const registered = await registerPlaygroundBun({ runtime, engine: "browser", module, profile: "split", launcher });
    expect(registered.profile).toBe("split");
    registered.dispose();
  } finally { await runtime.dispose(); }
});
