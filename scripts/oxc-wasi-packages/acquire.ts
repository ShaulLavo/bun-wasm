import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import inputs from "./inputs.lock.json" with { type: "json" };
import { object } from "./config.ts";

export function digest(bytes: Uint8Array, algorithm = "sha256", encoding: "hex" | "base64" = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

export function verifyIntegrity(bytes: Uint8Array, expected: string) {
  const actual = `sha512-${digest(bytes, "sha512", "base64")}`;
  if (actual !== expected) throw new Error(`Integrity mismatch: ${actual}`);
}

async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function acquirePackage(root: string, label: string, dist: { tarball: string; integrity: string }) {
  const bytes = await download(dist.tarball);
  verifyIntegrity(bytes, dist.integrity);
  const archive = join(root, `${label}.tgz`);
  const destination = join(root, label);
  await writeFile(archive, bytes);
  await mkdir(destination);
  execFileSync("tar", ["-xzf", archive, "-C", destination, "--no-same-owner", "--no-same-permissions"]);
  return join(destination, "package");
}

export async function verifyFiles(root: string, files: Readonly<Record<string, string | undefined>>) {
  for (const [file, expected] of Object.entries(files)) {
    if (typeof expected !== "string") throw new Error(`Missing input hash: ${file}`);
    if (digest(await readFile(join(root, file))) !== expected) throw new Error(`Changed pinned input: ${file}`);
  }
}

async function verifyProvenance(root: string, addon: (typeof inputs.addons)[number]) {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(addon.name)}@${addon.version}`;
  const bytes = await download(url);
  const envelope = object(JSON.parse(new TextDecoder().decode(bytes)));
  if (!Array.isArray(envelope.attestations)) throw new Error("Missing npm attestations");
  const statements = envelope.attestations.map(decodeStatement);
  const statement = statements.find(item => item.predicateType === "https://slsa.dev/provenance/v1");
  if (!statement) throw new Error("Missing source provenance statement");
  const definition = object(object(statement.predicate).buildDefinition);
  const dependencies = definition.resolvedDependencies;
  if (!Array.isArray(dependencies)) throw new Error("Missing source dependencies");
  const commit = object(object(dependencies[0]).digest).gitCommit;
  if (commit !== inputs.source.commit) throw new Error(`Unexpected release source: ${commit}`);
  const subjects = statement.subject;
  if (!Array.isArray(subjects)) throw new Error("Missing provenance subjects");
  const sha512 = object(object(subjects[0]).digest).sha512;
  const expected = Buffer.from(addon.dist.integrity.slice(7), "base64").toString("hex");
  if (sha512 !== expected) throw new Error("Provenance subject does not match pinned package");
  await writeFile(join(root, `${addon.addon}-attestation.json`), bytes);
}

function decodeStatement(value: unknown) {
  const bundle = object(object(value).bundle);
  const payload = object(bundle.dsseEnvelope).payload;
  if (typeof payload !== "string") throw new Error("Missing provenance payload");
  return object(JSON.parse(Buffer.from(payload, "base64").toString("utf8")));
}

export async function acquire(root: string) {
  await mkdir(root);
  const generator = await acquirePackage(root, "generator", inputs.generator.dist);
  await verifyFiles(generator, inputs.generator.files);
  const source = join(root, "source");
  for (const [path, expected] of Object.entries(inputs.source.files)) {
    const bytes = await download(`https://raw.githubusercontent.com/oxc-project/oxc/${inputs.source.commit}/${path}`);
    if (digest(bytes) !== expected) throw new Error(`Source hash mismatch: ${path}`);
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
  }
  for (const addon of inputs.addons) {
    await verifyProvenance(root, addon);
    const directory = await acquirePackage(root, addon.addon, addon.dist);
    await verifyFiles(directory, addon.files);
  }
  return { generator, source };
}
