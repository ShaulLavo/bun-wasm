import { join } from "node:path";
import { appendCustomSection, ENGINE_SECTION } from "../../src/engine-kind.ts";
import { fixtureReceipt, wasm } from "../../tests/package/guest-receipt-fixture.ts";
import { quickjsPair } from "../../tests/package/quickjs-plan-fixture.ts";
import { artifactIdentity } from "../guest-build-receipt.ts";
import { ordinaryJscFiles } from "../ci-ordinary-jsc-program.ts";
import { hash } from "../guest-source-manifest.ts";
import { jscEmbeddingArchives } from "../jsc-embedding.ts";

type Source = { head: string; tree: string };
export const deliveryFixtureSource = fixtureReceipt(wasm, "browser").sourceManifest.source;

export async function writeBrowserDeliveryFixture(directory: string, source = deliveryFixtureSource): Promise<void> {
  for (const build of ["browser", "tools", "quickjs"] as const) {
    const pair = build === "quickjs" ? quickjsPair() : undefined;
    const bytes = pair?.core ?? wasm;
    const receipt = fixtureReceipt(bytes, build, pair?.side);
    const sourceManifest = { ...receipt.sourceManifest, source };
    const name = build === "quickjs" ? "bun.wasm" : `bun-${build}.wasm`;
    await Bun.write(join(directory, name), bytes);
    await Bun.write(join(directory, `${name}.build.json`), JSON.stringify({ ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) }) + "\n");
    if (!pair || !("engineOrigin" in receipt)) continue;
    await Bun.write(join(directory, "quickjs.wasm"), pair.side);
    await Bun.write(join(directory, "quickjs.wasm.engine.json"), JSON.stringify(receipt.engineOrigin) + "\n");
  }
}

export async function writeJscDeliveryFixture(directory: string, source: Source = deliveryFixtureSource, maximum = 16384): Promise<void> {
  const pair = quickjsPair("jsc", maximum);
  const tag = appendCustomSection(new Uint8Array(), ENGINE_SECTION, new TextEncoder().encode("jsc"));
  const untagged = pair.core.subarray(0, pair.core.length - tag.length);
  const build = fixtureReceipt(pair.core, "jsc", pair.side);
  if (!("engineOrigin" in build)) throw new Error("Expected paired fixture");
  const stamp = "c".repeat(64);
  const archives = jscEmbeddingArchives.map(path => ({ path, sha256: hash(path) }));
  const groups = build.sourceManifest.groups.map(group => group.name === "jsc-prebuild"
    ? { name: group.name, files: [{ path: "build/jsc/.bunwasm-inputs", sha256: hash(stamp + "\n"), bytes: 65 }].concat(archives.map(file => ({ ...file, bytes: 7 }))) } : group);
  const sourceManifest = { ...build.sourceManifest, source, groups };
  const engineOrigin = { ...build.engineOrigin, inputs: { ...build.engineOrigin.inputs, source: { head: "1".repeat(40), tree: "2".repeat(40) } } };
  const coreContent = { selection: { features: ["engine-split", "bun-transpiler", "bun-build"] } };
  const coreOrigin = { schema: 1, inputs: { schema: 1, scope: "core", source: { head: "3".repeat(40), tree: "4".repeat(40) }, content: coreContent, contentSha256: hash(JSON.stringify(coreContent)) }, artifact: artifactIdentity(untagged) };
  const content = [pair.core, pair.side, JSON.stringify(coreOrigin) + "\n", JSON.stringify(engineOrigin) + "\n",
    JSON.stringify({ ...build, engineOrigin, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) }) + "\n",
    JSON.stringify({ sourceHead: source.head, sourceTree: source.tree, jscInputsSha256: stamp, archives, program: build.program }) + "\n"];
  for (const [index, name] of ordinaryJscFiles.entries()) await Bun.write(join(directory, name), content[index]!);
}
