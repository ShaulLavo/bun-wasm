import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { loadNodeProgram } from "../web/scripts/node-linked.ts";
import { memoryMaximumBytes, programKind, programProfile } from "../src/engine-kind.ts";
import { prepareProgram } from "../src/assets.ts";
import { createMemoryReader } from "../web/src/memory-telemetry.ts";

function directory(run: (path: string) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), "hermes-host-"));
  return run(path).finally(() => rmSync(path, { recursive: true, force: true }));
}

test("actual Node loader admits the explicit Hermes tag and companion", async () => {
  await directory(async path => {
    const pair = quickjsPair("hermes");
    const core = join(path, "bun-hermes.wasm");
    writeFileSync(core, pair.core);
    writeFileSync(join(path, "hermes-engine.wasm"), pair.side);
    const program = await loadNodeProgram(core, "hermes");
    expect(programKind(program.module)).toBe("hermes");
    expect(program.linkPlan?.libraries.map(library => library.id)).toEqual(["hermes"]);
    await expect(loadNodeProgram(core, "quickjs")).rejects.toThrow("Selected quickjs core declares hermes");
  });
});

test("Hermes admits neither a monolith nor a missing or wrong companion", async () => {
  await directory(async path => {
    const core = join(path, "bun-hermes.wasm");
    writeFileSync(core, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await expect(loadNodeProgram(core, "hermes")).rejects.toThrow("Selected hermes core declares single");
    writeFileSync(core, quickjsPair("hermes").core);
    await expect(loadNodeProgram(core, "hermes")).rejects.toThrow("ENOENT");
    writeFileSync(join(path, "hermes-engine.wasm"), quickjsPair("jsc").side);
    await expect(loadNodeProgram(core, "hermes")).rejects.toThrow("hermes companion");
  });
});

test("package preparation uses the Hermes initializer profile without defaulting to QuickJS", async () => {
  const pair = quickjsPair("hermes");
  expect(programKind(await prepareProgram({ kind: "hermes", ...pair }))).toBe("hermes");
  expect(programProfile("hermes")).toMatchObject({ core: "bun-hermes.wasm", side: "hermes-engine.wasm", run: "hermes_run" });
  await expect(prepareProgram({ kind: "hermes", core: pair.core, side: quickjsPair("quickjs").side })).rejects.toThrow("hermes companion");
});

test("Hermes memory stays unknown while core capacity remains separate", () => {
  const { core } = quickjsPair("hermes");
  const instance = new WebAssembly.Instance(new WebAssembly.Module(core), { runtime_proc: { signal: () => 0 } });
  const reader = createMemoryReader("hermes", instance, undefined, memoryMaximumBytes(core) ?? null);
  const snapshot = reader.sample(true);
  expect(snapshot.engine).toBe("hermes");
  expect(snapshot.wasmCapacityBytes).toBe(65536);
  expect(snapshot.jsHeapBytes).toBeNull();
  expect(snapshot.arrayBufferBytes).toBeNull();
  expect(snapshot.engineCounters).toEqual({});
  expect(reader.finish().terminal).toBe(true);
});
