import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRuntime, type GuestLauncher } from "waffle";
import { prepareProgram } from "../src/assets";
import { BUN_MEMORY_GROUP_POLICY, isPairedEngine, programKind, programProfile, type Engine } from "../src/engine-kind";
import { ENGINE_BIN } from "../src/executable-paths";
import { registerPlaygroundBun } from "../web/src/playground/program-profile";
import { PACKAGE_ADAPTER, PACKAGE_CONTINUATION } from "../src/package-continuation-binding";

test("the supplied shared pair preserves explicit playground registration and profile refusal", async () => {
  const path = process.env.BUN_WASM_PROFILE_PROGRAM;
  if (!path) throw new Error("Set BUN_WASM_PROFILE_PROGRAM to the matching shared paired core");
  const core = new Uint8Array(readFileSync(path));
  const compiled = await WebAssembly.compile(core);
  const engine = programKind(compiled);
  if (!isPairedEngine(engine)) throw new Error("Expected a paired engine");
  const side = new Uint8Array(readFileSync(join(dirname(path), programProfile(engine).side)));
  const module = engine === "spidermonkey" ? compiled : await prepareProgram({ kind: engine, core, side });
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("../web/src/fs-worker.ts", import.meta.url) }, memoryGroups: BUN_MEMORY_GROUP_POLICY });
  const adapters = spyOn(runtime, "registerAdapter"), programs = spyOn(runtime, "registerProgram");
  const launcher: GuestLauncher = () => { throw new Error("No process should start during registration"); };
  const providers = { launcher: () => launcher, async loadModule() { throw new Error("Other engine modules stay lazy"); } };
  try {
    await expect(registerPlaygroundBun({ runtime, engine, module, profile: "split", ...providers })).rejects.toThrow("core is shared-group");
    expect(adapters).not.toHaveBeenCalled();
    expect(programs).not.toHaveBeenCalled();
    const registered = await registerPlaygroundBun({ runtime, engine, module, profile: "shared-group", ...providers });
    expect(registered.profile).toBe("shared-group");
    const engines: readonly Engine[] = engine === "spidermonkey" ? ["quickjs", "jsc", "browser", engine] : ["quickjs", "jsc", "browser"];
    expect(programs.mock.calls.map(([name]) => name)).toEqual([PACKAGE_CONTINUATION].concat(engines.flatMap(provider => ["bun", "bunx", "node", "nodejs"].map(name => `${ENGINE_BIN[provider]}/${name}`))));
    const continuation = programs.mock.calls[0]?.[1];
    expect(continuation?.adapter).toBe(PACKAGE_ADAPTER);
    if (!(continuation?.module instanceof WebAssembly.Module)) throw new Error("Expected the private host continuation module");
    expect(WebAssembly.Module.imports(continuation.module)).toEqual([]);
    expect(WebAssembly.Module.exports(continuation.module)).toEqual([]);
    for (const [path, program] of programs.mock.calls.slice(1)) {
      if (!path.startsWith(`${registered.bin}/`)) continue;
      expect(program.adapter).toBe(`bun:${engine}`);
      if (typeof program.module !== "function") throw new Error("Expected the prepared module callback");
      expect(await program.module()).toBe(module);
    }
    expect(await runtime.filesystem.lookup(`${registered.bin}/bun`)).toBeDefined();
    registered.dispose();
  } finally { adapters.mockRestore(); programs.mockRestore(); await runtime.dispose(); }
}, 30_000);
