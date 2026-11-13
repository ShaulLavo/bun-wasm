import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { prepareProgram } from "../src/assets";
import { BUN_MEMORY_GROUP_POLICY, programProfile, tagProgramCore, type PairedEngine } from "../src/engine-kind";
import { verifySharedProgramMemory, type BackingPolicy } from "./shared-program-memory";
import { profileAsset, verifyMemoryProfile } from "../web/src/program-profile";
import { inputProfile, parseProgramReceipt, record, verifyProgramReceipt, type ProgramInputSnapshot } from "./guest-core-receipt";

export function sharedProgramReceipts(engine: PairedEngine): string[] {
  return ["bun-core.wasm.core.json", "source.txt"].concat(engine === "spidermonkey"
    ? ["spidermonkey-shared.json", "shared-group-library.json"] : [`${programProfile(engine).side}.engine.json`]);
}

/** Consume complete programs from the existing shared-profile producers. Never build a guest. */
export async function stageSharedPrograms(out: string, builds: Record<string, string>, inputs: Partial<Record<PairedEngine, string | undefined>> = {
  quickjs: process.env.SHARED_QUICKJS_PROGRAM,
  jsc: process.env.SHARED_JSC_PROGRAM,
  spidermonkey: process.env.SHARED_SPIDERMONKEY_PROGRAM,
}, policy: BackingPolicy = BUN_MEMORY_GROUP_POLICY): Promise<void> {
  for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) {
    const source = inputs[engine];
    if (source) await stageProgram(engine, source, out, builds, policy);
  }
}

function verifyIdentity(bytes: Uint8Array, value: unknown): void {
  assert(record(value), "Missing shared SpiderMonkey artifact identity");
  assert.equal(value.bytes, bytes.byteLength, "Shared SpiderMonkey artifact size mismatch");
  assert.equal(value.sha256, new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), "Shared SpiderMonkey artifact hash mismatch");
}

function requireNativeIdentity(value: unknown, field: "bytes" | "count", label: string): void {
  assert(record(value), `Missing shared SpiderMonkey ${label} identity`);
  assert(typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256), `Invalid shared SpiderMonkey ${label} identity digest`);
  const size = value[field];
  assert(typeof size === "number" && Number.isSafeInteger(size) && size > 0, `Invalid shared SpiderMonkey ${label} identity ${field}`);
}

async function spiderMonkeyReceipts(source: string, core: Uint8Array, side: Uint8Array, coreFile: Awaited<ReturnType<typeof receiptFile>>) {
  const files = await Promise.all(["spidermonkey-shared.json", "shared-group-library.json"].map(async name => ({ name, text: await Bun.file(join(source, name)).text() })));
  const pair: unknown = JSON.parse(files[0]!.text), library: unknown = JSON.parse(files[1]!.text);
  assert(record(pair) && pair.schema === 1 && pair.experimental === true && pair.profile === "shared-group", "Invalid shared SpiderMonkey receipt");
  assert(record(pair.inputs) && record(pair.inputs.native), "Missing shared SpiderMonkey inputs");
  assert.deepEqual(pair.inputs.coreReceipt, coreFile.receipt, "Shared SpiderMonkey core receipt mismatch");
  assert.deepEqual(pair.inputs.source, coreFile.receipt.inputs.source, "Shared SpiderMonkey source mismatch");
  assert.equal((await Bun.file(join(source, "source.txt")).text()).trim(), coreFile.receipt.inputs.source.head, "Shared SpiderMonkey source label mismatch");
  verifyIdentity(core, pair.program);
  verifyIdentity(side, pair.side);
  verifyIdentity(core.subarray(0, coreFile.receipt.artifact.artifactBytes), pair.inputs.core);
  verifyIdentity(new TextEncoder().encode(files[1]!.text), pair.inputs.native.receipt);
  assert(record(library) && library.profile === "shared-group", "Invalid shared SpiderMonkey library receipt");
  for (const native of [library, pair.inputs.native]) {
    requireNativeIdentity(native.library, "bytes", "library");
    requireNativeIdentity(native.headers, "count", "header");
  }
  assert.deepEqual(library.library && record(library.library) ? { sha256: library.library.sha256, bytes: library.library.bytes } : null, pair.inputs.native.library, "Shared SpiderMonkey library identity mismatch");
  assert.deepEqual(library.headers, pair.inputs.native.headers, "Shared SpiderMonkey header identity mismatch");
  return files;
}

async function receiptFile(source: string, name: string, scope: ProgramInputSnapshot["scope"]) {
  const text = await Bun.file(join(source, name)).text();
  const receipt = parseProgramReceipt(JSON.parse(text));
  if (receipt.inputs.scope !== scope || inputProfile(receipt.inputs) !== "shared-group") throw new Error("Shared program receipt scope or profile mismatch");
  return { name, text, receipt };
}

async function verifiedSideReceipt(source: string, name: string, engine: "quickjs" | "jsc", side: Uint8Array) {
  const file = await receiptFile(source, name, engine);
  verifyProgramReceipt(side, file.receipt, file.receipt.inputs);
  return [file];
}

async function stageProgram(engine: PairedEngine, source: string, out: string, builds: Record<string, string>, policy: BackingPolicy): Promise<void> {
  const names = programProfile(engine);
  // Existing shared producers export their tagged core as bun.wasm.
  const core = await Bun.file(join(source, "bun.wasm")).bytes();
  const side = await Bun.file(join(source, names.side)).bytes();
  const module = await prepareProgram({ kind: engine, core, side });
  verifyMemoryProfile(module, "shared-group");
  verifySharedProgramMemory(core, side, policy);
  const coreFile = await receiptFile(source, "bun-core.wasm.core.json", "core");
  const untaggedCore = core.subarray(0, coreFile.receipt.artifact.artifactBytes);
  verifyProgramReceipt(untaggedCore, coreFile.receipt, coreFile.receipt.inputs);
  const taggedCore = tagProgramCore(untaggedCore, engine);
  if (!Buffer.from(core.buffer, core.byteOffset, core.byteLength).equals(taggedCore)) throw new Error("Program core does not match tagged receipt bytes");
  const sideFiles = engine === "spidermonkey" ? await spiderMonkeyReceipts(source, core, side, coreFile) : await verifiedSideReceipt(source, `${names.side}.engine.json`, engine, side);
  const origin = { name: "source.txt", text: await Bun.file(join(source, "source.txt")).text() };
  const receipts = join(out, profileAsset(`receipts/${engine}`, "shared-group"));
  await mkdir(receipts, { recursive: true });
  const files: { name: string; text: string }[] = [coreFile, origin];
  for (const file of files.concat(sideFiles)) {
    await Bun.write(join(receipts, file.name), file.text);
  }
  for (const file of [{ name: names.core, bytes: core }, { name: names.side, bytes: side }]) {
    const name = profileAsset(file.name, "shared-group");
    builds[name] = new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex");
    await Bun.write(join(out, `${name}.gz`), Bun.gzipSync(file.bytes, { level: 9 }));
  }
}
