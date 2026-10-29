import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseProgramReceipt, record, verifyProgramReceipt, type ProgramInputSnapshot } from "../../scripts/guest-core-receipt";
import { hash } from "../../scripts/guest-source-manifest";
import { tagProgramCore } from "../../src/engine-kind";

function argument(index: number): string {
  const value = process.argv[index];
  if (!value) throw new Error("Usage: bun tests/hermes/pair.ts CORE SIDE OUTPUT_DIRECTORY");
  return resolve(value);
}
const corePath = argument(2), sidePath = argument(3), output = argument(4);
const repository = resolve(import.meta.dir, "../..");
function inputFiles(input: ProgramInputSnapshot): Map<string, string> {
  const content = input.content;
  if (!record(content) || !Array.isArray(content.groups)) throw new Error("Missing input groups");
  const repositoryGroup: unknown = content.groups.find(group => record(group) && group.name === "repository");
  if (!record(repositoryGroup) || !Array.isArray(repositoryGroup.files)) throw new Error("Missing repository group");
  return new Map(repositoryGroup.files.map((file: unknown) => {
    if (!record(file) || typeof file.path !== "string" || typeof file.sha256 !== "string") throw new Error("Invalid source input");
    return [file.path, file.sha256];
  }));
}
function verifySources(input: ProgramInputSnapshot, paths: readonly string[]): void {
  const files = inputFiles(input);
  for (const path of paths) {
    if (files.get(path) !== hash(readFileSync(join(repository, path)))) throw new Error(`Source differs from paired contract: ${path}`);
  }
}
function artifact(path: string, suffix: string) {
  const bytes = new Uint8Array(readFileSync(path));
  const origin = parseProgramReceipt(JSON.parse(readFileSync(`${path}.${suffix}.json`, "utf8")));
  const receipt = verifyProgramReceipt(bytes, origin, origin.inputs);
  return { bytes, receipt };
}
const core = artifact(corePath, "core"), side = artifact(sidePath, "engine");
if (core.receipt.inputs.scope !== "core" || side.receipt.inputs.scope !== "hermes") throw new Error("Expected core and Hermes side");
verifySources(core.receipt.inputs, [
  "crates/bunwasm-runtime/src/js/esm_loader.ts", "crates/bunwasm-runtime/src/split_api.rs",
  "crates/bunwasm-runtime/src/engine.rs", "crates/bunwasm-runtime/src/transpiler.rs",
  "crates/bunwasm-transpiler/src/register.rs",
  "patches/bun/0017-wasm-print-ES-module-bodies-for-registration-records.patch",
]);
verifySources(side.receipt.inputs, ["crates/bunwasm-engine-hermes/src/vm.rs", "crates/bunwasm-engine-quickjs/src/loader.rs"]);
const tagged = tagProgramCore(core.bytes, "hermes");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "bun-hermes.wasm"), tagged);
copyFileSync(sidePath, join(output, "hermes-engine.wasm"));
copyFileSync(`${sidePath}.engine.json`, join(output, "hermes-engine.wasm.engine.json"));
writeFileSync(join(output, "SOURCE-IDENTITIES.json"), JSON.stringify({
  core: { path: corePath, source: core.receipt.inputs.source, inputsSha256: core.receipt.inputs.contentSha256, artifact: core.receipt.artifact },
  side: { path: sidePath, source: side.receipt.inputs.source, inputsSha256: side.receipt.inputs.contentSha256, artifact: side.receipt.artifact },
  taggedCore: { path: join(output, "bun-hermes.wasm"), sha256: hash(tagged), bytes: tagged.byteLength },
  qualification: "Verified separate origin receipts and shared module-source contract. No combined guest receipt or new origin is claimed.",
}, null, 2) + "\n");
console.log(join(output, "bun-hermes.wasm"));
