import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareProgram } from "../src/assets";
import { programProfile, type SupportedPairedEngine } from "../src/engine-kind";
import { profileAsset, verifyMemoryProfile } from "../web/src/program-profile";

/** Consume complete programs from the existing shared-profile producers. Never build a guest. */
export async function stageSharedPrograms(out: string, builds: Record<string, string>, inputs = {
  quickjs: process.env.SHARED_QUICKJS_PROGRAM,
  jsc: process.env.SHARED_JSC_PROGRAM,
}): Promise<void> {
  for (const engine of ["quickjs", "jsc"] as const) {
    const source = inputs[engine];
    if (source) await stageProgram(engine, source, out, builds);
  }
}

async function stageProgram(engine: SupportedPairedEngine, source: string, out: string, builds: Record<string, string>): Promise<void> {
  const names = programProfile(engine);
  // Both existing producers export their tagged core as bun.wasm.
  const core = await Bun.file(join(source, "bun.wasm")).bytes();
  const side = await Bun.file(join(source, names.side)).bytes();
  const module = await prepareProgram({ kind: engine, core, side });
  verifyMemoryProfile(module, "shared-group");
  const receipts = join(out, profileAsset(`receipts/${engine}`, "shared-group"));
  await mkdir(receipts, { recursive: true });
  for (const name of ["bun-core.wasm.core.json", `${names.side}.engine.json`, "source.txt"]) {
    await cp(join(source, name), join(receipts, name));
  }
  for (const file of [{ name: names.core, bytes: core }, { name: names.side, bytes: side }]) {
    const name = profileAsset(file.name, "shared-group");
    builds[name] = new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex");
    await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(file.bytes, { level: 9 }));
  }
}
