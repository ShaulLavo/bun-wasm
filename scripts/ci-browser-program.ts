import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { artifactIdentity, verifyGuestBuildReceipt, verifyGuestCompanions } from "./guest-build-receipt.ts";
import { git, guestBuilds } from "./guest-source-manifest.ts";
import { parseProgramReceipt, verifyProgramReceipt, type ProgramInputSnapshot } from "./guest-core-receipt.ts";
import { writeProgramDelivery } from "./ci-program-delivery.ts";
import { assertShippedGuestHasNoNames } from "./wasm-name-sections.ts";

type Source = ProgramInputSnapshot["source"];
export const browserProgramFiles = ["bun-browser.wasm", "bun-browser.wasm.build.json", "bun-tools.wasm", "bun-tools.wasm.build.json",
  "bun.wasm", "bun.wasm.build.json", "quickjs.wasm", "quickjs.wasm.engine.json"] as const;

export async function verifyBrowserProgram(directory: string, source: Source) {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const programs = [];
  for (const build of ["browser", "tools", "quickjs"] as const) {
    const name = guestBuilds[build].artifact;
    const bytes = await Bun.file(join(directory, name)).bytes();
    assertShippedGuestHasNoNames(name, bytes);
    const receiptBytes = await Bun.file(join(directory, `${name}.build.json`)).bytes();
    const receipt: unknown = JSON.parse(new TextDecoder().decode(receiptBytes));
    verifyGuestBuildReceipt(bytes, receipt);
    assert.equal(receipt.sourceManifest.build, build, `Standard ${build} recipe required`);
    assert.deepEqual(receipt.sourceManifest.source, source, `${build} source mismatch`);
    assert.equal(receipt.profile, undefined, `${build} split profile required`);
    await verifyGuestCompanions(receipt, directory);
    programs.push({ build, name, ...artifactIdentity(bytes), source: receipt.sourceManifest.source,
      inputs: { bunHead: receipt.bunHead, bunTree: receipt.bunTree, sysrootReceiptSha256: receipt.sysrootReceiptSha256 } });
    files.push({ name, bytes }, { name: `${name}.build.json`, bytes: receiptBytes });
    if (build !== "quickjs") continue;
    assert("engineOrigin" in receipt, "QuickJS origin required");
    const side = await Bun.file(join(directory, "quickjs.wasm")).bytes();
    const originBytes = await Bun.file(join(directory, "quickjs.wasm.engine.json")).bytes();
    const origin = parseProgramReceipt(JSON.parse(new TextDecoder().decode(originBytes)));
    assert.equal(origin.inputs.scope, "quickjs", "QuickJS side receipt required");
    verifyProgramReceipt(side, origin, origin.inputs);
    assert.deepEqual(origin, receipt.engineOrigin, "QuickJS independent origin mismatch");
    files.push({ name: "quickjs.wasm", bytes: side }, { name: "quickjs.wasm.engine.json", bytes: originBytes });
  }
  for (const program of programs.slice(1)) assert.deepEqual(programs[0]?.inputs, program.inputs, "Browser/tools/QuickJS patched Bun or sysroot mismatch");
  return { files, delivery: { schema: 1, profile: "split", source, programs, files: files.map(file => ({ name: file.name, ...artifactIdentity(file.bytes) })) } };
}

export async function exportBrowserProgram(directory: string, output: string, source: Source): Promise<void> {
  const verified = await verifyBrowserProgram(directory, source);
  await writeProgramDelivery(output, verified.files, verified.delivery);
}

if (import.meta.main) {
  const [command, directory, ...extra] = process.argv.slice(2);
  assert(directory && extra.length === 0 && (command === "export" || command === "verify"), "Usage: ci-browser-program.ts export OUTPUT | verify INPUT");
  const root = resolve(import.meta.dir, "..");
  const source = { head: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
  if (command === "export") await exportBrowserProgram(join(root, "dist"), resolve(directory), source);
  else {
    const result = await verifyBrowserProgram(resolve(directory), source);
    assert.deepEqual(await Bun.file(join(directory, "delivery.json")).json(), result.delivery, "Browser delivery metadata mismatch");
    assert.equal(await Bun.file(join(directory, "source.txt")).text(), `${source.head}\n${source.tree}\n`, "Browser source label mismatch");
  }
}
