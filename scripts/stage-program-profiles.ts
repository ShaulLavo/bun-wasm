import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareProgram } from "../src/assets";
import { BUN_MEMORY_GROUP_POLICY, importedMemory, programProfile, tagProgramCore, type SupportedPairedEngine } from "../src/engine-kind";
import { profileAsset, verifyMemoryProfile } from "../web/src/program-profile";
import { inputProfile, parseProgramReceipt, verifyProgramReceipt, type ProgramInputSnapshot } from "./guest-core-receipt";

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

async function receiptFile(source: string, name: string, scope: ProgramInputSnapshot["scope"]) {
  const text = await Bun.file(join(source, name)).text();
  const receipt = parseProgramReceipt(JSON.parse(text));
  if (receipt.inputs.scope !== scope || inputProfile(receipt.inputs) !== "shared-group") throw new Error("Shared program receipt scope or profile mismatch");
  return { name, text, receipt };
}

async function stageProgram(engine: SupportedPairedEngine, source: string, out: string, builds: Record<string, string>): Promise<void> {
  const names = programProfile(engine);
  // Both existing producers export their tagged core as bun.wasm.
  const core = await Bun.file(join(source, "bun.wasm")).bytes();
  const side = await Bun.file(join(source, names.side)).bytes();
  const module = await prepareProgram({ kind: engine, core, side });
  verifyMemoryProfile(module, "shared-group");
  for (const bytes of [core, side]) {
    const memory = importedMemory(bytes);
    if (!memory?.shared || memory.maximum !== BUN_MEMORY_GROUP_POLICY.maximumPages) throw new Error("Shared program memory must match the current group address space");
  }
  const coreFile = await receiptFile(source, "bun-core.wasm.core.json", "core");
  const sideFile = await receiptFile(source, `${names.side}.engine.json`, engine);
  const untaggedCore = core.subarray(0, coreFile.receipt.artifact.artifactBytes);
  verifyProgramReceipt(untaggedCore, coreFile.receipt, coreFile.receipt.inputs);
  const taggedCore = tagProgramCore(untaggedCore, engine);
  if (!Buffer.from(core.buffer, core.byteOffset, core.byteLength).equals(taggedCore)) throw new Error("Program core does not match tagged receipt bytes");
  verifyProgramReceipt(side, sideFile.receipt, sideFile.receipt.inputs);
  const origin = { name: "source.txt", text: await Bun.file(join(source, "source.txt")).text() };
  const receipts = join(out, profileAsset(`receipts/${engine}`, "shared-group"));
  await mkdir(receipts, { recursive: true });
  for (const file of [coreFile, sideFile, origin]) {
    await Bun.write(join(receipts, file.name), file.text);
  }
  for (const file of [{ name: names.core, bytes: core }, { name: names.side, bytes: side }]) {
    const name = profileAsset(file.name, "shared-group");
    builds[name] = new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex");
    await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(file.bytes, { level: 9 }));
  }
}
