import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareProgram } from "../src/assets.ts";
import { tagProgramCore, wasmMemoryLimits } from "../src/engine-kind.ts";
import { jscStackBudgets } from "../web/src/engine-stack-budget.ts";
import { verifyMemoryProfile } from "../web/src/program-profile.ts";
import { artifactIdentity, verifyGuestBuildReceipt, verifyGuestCompanions, type GuestBuildReceipt } from "./guest-build-receipt.ts";
import { inputProfile, parseProgramReceipt, record, verifyProgramReceipt, type ProgramInputSnapshot } from "./guest-core-receipt.ts";
import { git, hash } from "./guest-source-manifest.ts";
import { jscEmbeddingArchives, verifyEmbeddingReceipt } from "./jsc-embedding.ts";

type Source = ProgramInputSnapshot["source"];
export const ordinaryJscFiles = ["bun-jsc.wasm", "jsc-engine.wasm", "bun-core.wasm.core.json", "jsc-engine.wasm.engine.json", "bun-jsc.wasm.build.json", "bun-jsc.wasm.embedding.json"] as const;

function verifyEmbedding(value: unknown, build: GuestBuildReceipt, core: Uint8Array, side: Uint8Array): void {
  assert(record(value) && typeof value.jscInputsSha256 === "string" && /^[0-9a-f]{64}$/.test(value.jscInputsSha256), "Invalid JSC embedding inputs");
  const files = build.sourceManifest.groups.find(group => group.name === "jsc-prebuild")!.files;
  assert.equal(files.find(file => file.path === "build/jsc/.bunwasm-inputs")?.sha256, hash(value.jscInputsSha256 + "\n"), "JSC embedding input stamp mismatch");
  const archives = jscEmbeddingArchives.map(path => {
    const file = files.find(file => file.path === path);
    assert(file, `Missing JSC embedding archive ${path}`);
    return { path, sha256: file.sha256 };
  });
  const source = build.sourceManifest.source;
  verifyEmbeddingReceipt(value, { sourceHead: source.head, sourceTree: source.tree, jscInputsSha256: value.jscInputsSha256, archives }, { kind: "jsc", core, side });
}

export async function verifyOrdinaryJscProgram(directory: string, coreReceipt: string, source: Source) {
  const paths = ordinaryJscFiles.map(name => name === "bun-core.wasm.core.json" ? coreReceipt : join(directory, name));
  const files = await Promise.all(paths.map(path => Bun.file(path).bytes()));
  const [core, side, coreText, sideText, buildText, embeddingText] = files;
  assert(core && side && coreText && sideText && buildText && embeddingText, "Incomplete ordinary JSC program");
  const build: unknown = JSON.parse(new TextDecoder().decode(buildText));
  verifyGuestBuildReceipt(core, build);
  assert.equal(build.sourceManifest.build, "jsc", "Ordinary JSC build required");
  assert.equal(build.profile, undefined, "Ordinary JSC split receipt required");
  assert.deepEqual(build.sourceManifest.source, source, "Ordinary JSC composing source mismatch");
  await verifyGuestCompanions(build, directory);
  const module = await prepareProgram({ kind: "jsc", core, side });
  verifyMemoryProfile(module, "split");
  const coreMemory = wasmMemoryLimits(core), sideMemory = wasmMemoryLimits(side);
  assert.equal(coreMemory.length, 1, "Ordinary JSC needs one core memory");
  assert.equal(sideMemory.length, 1, "Ordinary JSC needs one side memory");
  assert.deepEqual(coreMemory[0], { origin: "defined", initial: coreMemory[0]!.initial, shared: false, maximum: 16384 }, "Ordinary JSC needs private 1 GiB core memory");
  assert(sideMemory[0]!.origin === "imported" && !sideMemory[0]!.shared, "Ordinary JSC needs a private split side");
  const coreOrigin = parseProgramReceipt(JSON.parse(new TextDecoder().decode(coreText)));
  const sideOrigin = parseProgramReceipt(JSON.parse(new TextDecoder().decode(sideText)));
  assert(coreOrigin.inputs.scope === "core" && inputProfile(coreOrigin.inputs) === "split", "Ordinary JSC core receipt scope or profile mismatch");
  assert(sideOrigin.inputs.scope === "jsc" && inputProfile(sideOrigin.inputs) === "split", "Ordinary JSC side receipt scope or profile mismatch");
  const untagged = core.subarray(0, coreOrigin.artifact.artifactBytes);
  verifyProgramReceipt(untagged, coreOrigin, coreOrigin.inputs);
  assert.deepEqual(core, tagProgramCore(untagged, "jsc"), "Ordinary JSC core differs from its original receipt");
  verifyProgramReceipt(side, sideOrigin, sideOrigin.inputs);
  assert("engineOrigin" in build, "Missing JSC engine origin");
  assert.deepEqual(sideOrigin, build.engineOrigin, "Ordinary JSC side origin differs from build receipt");
  verifyEmbedding(JSON.parse(new TextDecoder().decode(embeddingText)), build, core, side);
  const delivery = {
    schema: 1, engine: "jsc", profile: "split", source,
    components: { core: { ...artifactIdentity(core), source: coreOrigin.inputs.source, inputSha256: coreOrigin.inputs.contentSha256 },
      side: { ...artifactIdentity(side), source: sideOrigin.inputs.source, inputSha256: sideOrigin.inputs.contentSha256 } },
    capacity: { maximumMemoryBytes: 16384 * 65536, coreMemory: coreMemory[0], sideMemory: sideMemory[0], environment: { BUN_WASM_STACK_KIB: jscStackBudgets.other } },
    files: ordinaryJscFiles.map((name, index) => ({ name, ...artifactIdentity(files[index]!) })),
  };
  return { files, delivery };
}

export async function exportOrdinaryJscProgram(directory: string, coreReceipt: string, output: string, source: Source): Promise<void> {
  const verified = await verifyOrdinaryJscProgram(directory, coreReceipt, source);
  await mkdir(output);
  try {
    for (const [index, name] of ordinaryJscFiles.entries()) await Bun.write(join(output, name), verified.files[index]!);
    await Bun.write(join(output, "source.txt"), `${source.head}\n${source.tree}\n`);
    await Bun.write(join(output, "delivery.json"), JSON.stringify(verified.delivery, null, 2) + "\n");
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [command, directory, ...extra] = process.argv.slice(2);
  assert(directory && extra.length === 0 && (command === "export" || command === "verify"), "Usage: ci-ordinary-jsc-program.ts export OUTPUT | verify INPUT");
  const root = resolve(import.meta.dir, "..");
  const source = { head: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
  if (command === "export") {
    assert(process.env.CARGO_TARGET_DIR, "Source env.sh before exporting");
    const core = process.env.BUN_CORE_BUILD_DIR ?? join(process.env.CARGO_TARGET_DIR, "split-common");
    await exportOrdinaryJscProgram(join(root, "dist"), join(core, "bun-core.wasm.core.json"), resolve(directory), source);
  } else {
    const result = await verifyOrdinaryJscProgram(resolve(directory), join(resolve(directory), "bun-core.wasm.core.json"), source);
    assert.deepEqual(await Bun.file(join(directory, "delivery.json")).json(), result.delivery, "Ordinary JSC delivery metadata mismatch");
    assert.equal(await Bun.file(join(directory, "source.txt")).text(), `${source.head}\n${source.tree}\n`, "Ordinary JSC source label mismatch");
  }
}
