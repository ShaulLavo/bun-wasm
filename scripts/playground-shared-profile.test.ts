import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRuntime, type GuestLauncher } from "waffle";
import { prepareProgram } from "../src/assets";
import { BUN_MEMORY_GROUP_POLICY, programKind, programProfile } from "../src/engine-kind";
import { registerPlaygroundBun } from "../web/src/playground/program-profile";

test("the supplied real shared pair registers only with explicit shared-group playground intent", async () => {
  const path = process.env.BUN_WASM_PROFILE_PROGRAM;
  if (!path) throw new Error("Set BUN_WASM_PROFILE_PROGRAM to the matching shared QuickJS or JSC core");
  const core = new Uint8Array(readFileSync(path));
  const engine = programKind(await WebAssembly.compile(core));
  if (engine !== "quickjs" && engine !== "jsc") throw new Error("Expected a supported paired engine");
  const side = new Uint8Array(readFileSync(join(dirname(path), programProfile(engine).side)));
  const module = await prepareProgram({ kind: engine, core, side });
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../web/src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const adapters = spyOn(runtime, "registerAdapter"), programs = spyOn(runtime, "registerProgram");
  const launcher: GuestLauncher = () => { throw new Error("No process should start during registration"); };
  try {
    await expect(registerPlaygroundBun({ runtime, engine, module, profile: "split", launcher })).rejects.toThrow("core is shared-group");
    expect(adapters).not.toHaveBeenCalled();
    expect(programs).not.toHaveBeenCalled();
    const registered = await registerPlaygroundBun({ runtime, engine, module, profile: "shared-group", launcher });
    expect(registered.profile).toBe("shared-group");
    expect(programs).toHaveBeenCalledTimes(3);
    for (const [, program] of programs.mock.calls) {
      if (typeof program.module !== "function") throw new Error("Expected the prepared module callback");
      expect(await program.module()).toBe(module);
    }
    expect(await runtime.filesystem.lookup(`${registered.bin}/bun`)).toBeDefined();
    registered.dispose();
  } finally { adapters.mockRestore(); programs.mockRestore(); await runtime.dispose(); }
}, 30_000);
