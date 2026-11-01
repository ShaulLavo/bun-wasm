import { appendFile, mkdir, mkdtemp, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { completePublicationArtifactPaths, publicationAssets } from "./producer-closure.ts";
import { fileIdentity, parentOwner, type TlsEvidence } from "./tls-qualification-inputs.ts";

export async function qualificationFixture() {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-tls-parser-"));
  try { await fixtureLedger({ created: root, kind: "synthetic-parser-only" }); return await prepareFixture(root); }
  catch (error) { await rm(root, { recursive: true, force: true }); await fixtureLedger({ removed: root }); throw error; }
}
async function fixtureLedger(row: object): Promise<void> {
  const ledger = process.env.TLS_SOURCE_RESOURCE_LEDGER;
  if (ledger) await appendFile(ledger, JSON.stringify(row) + "\n");
}
async function prepareFixture(root: string) {
  const delivery = join(root, "delivery");
  const reviewedSource = { head: "a".repeat(40), tree: "b".repeat(40) };
  const put = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value)); };
  const releasePath = join(root, "source-release.json");
  const parentPath = join(root, "parent.json");
  const files = Array.from(new Set(completePublicationArtifactPaths()));
  for (const path of files) await put(join(delivery, path), "Synthetic parser bytes, never a guest or admission");
  for (const family of ["", "native-custody-", "vendor-custody-"]) {
    for (const phase of ["before", "after", "preseal"]) await put(join(delivery, `inputs/${family}${phase}.json`), { syntheticParserOnly: family });
  }
  const backing = { jsc: join(root, "jsc"), sysroot: join(root, "sysroot") };
  const tuple = { runtime: "0.0.109", relay: "0.0.109", hostInterface: 1, engines: ["quickjs", "jsc", "browser"] };
  await put(join(delivery, "inputs/ADMISSION.json"), { source: reviewedSource, nativeBacking: backing, builds: Object.fromEntries(publicationAssets.map(name => [name, "c".repeat(64)])) });
  await put(join(delivery, "inputs/CANONICAL-REUSE.json"), { staged: [] });
  await put(releasePath, { kind: "tested-producer-source-release", source: reviewedSource, tuple });
  const ref = async (path: string) => ({ path, ...await fileIdentity(path) });
  const parent: Record<string, unknown> = {
    kind: "independent-parent-byte-admission", owner: parentOwner, parentByteIntakePassed: true, packetBytesAdmitted: true,
    source: reviewedSource, deliveryRoot: delivery, tuple,
    byteIntake: { missingExtraSymlinkOrBadHashes: 0, sourceArchiveMatchesExactGitArchive: true, normalBuildProgramCompanionLauncherAndClosureHelpersPassed: true },
  };
  async function seal(): Promise<TlsEvidence> {
    await put(join(delivery, "DELIVERY.json"), { source: reviewedSource, nativeBacking: backing, files: await Promise.all(files.map(async path => ({ path, ...await fileIdentity(join(delivery, path)) }))) });
    if (parent.gates === undefined) parent.gates = { beforeAfterPresealCustody: Object.fromEntries(await Promise.all(["", "native-custody-", "vendor-custody-"].map(async family => [family || "source-inputs", await fileIdentity(join(delivery, `inputs/${family}before.json`))]))) };
    parent.deliveryManifest = await ref(join(delivery, "DELIVERY.json"));
    parent.producerAdmission = await ref(join(delivery, "inputs/ADMISSION.json"));
    parent.canonicalReuse = await ref(join(delivery, "inputs/CANONICAL-REUSE.json"));
    parent.sourceArchive = await ref(join(delivery, "source.tar.gz"));
    parent.sourceRelease = await ref(releasePath);
    await put(parentPath, parent);
    return { delivery, admission: parentPath, admissionSha256: (await fileIdentity(parentPath)).sha256, deliverySha256: (await fileIdentity(join(delivery, "DELIVERY.json"))).sha256,
      sourceReleaseSha256: (await fileIdentity(releasePath)).sha256, reviewedSource, hostSource: join(root, "not-a-reviewed-host"), pgModules: join(root, "pg"), pgArchive: join(root, "public-pg.tgz"), pgArchiveSha256: "f".repeat(64) };
  }
  return { root, delivery, parent, put, seal, close: () => removeFixture(root) };
}
async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  try { await lstat(root); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") { await fixtureLedger({ absent: root }); return; }
    throw error;
  }
  throw new Error("TLS parser fixture retained");
}
