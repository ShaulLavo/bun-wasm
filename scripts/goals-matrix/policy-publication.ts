import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertNoPublication, publicationMarker, withCanonicalWriter } from "./canonical-write";
import { object, text } from "./evidence";

export const metadataFiles = ["TABLE.json", "VIEW.json", "TABLE.md", "CAMPAIGN-POLICY.json"] as const;
export { publicationMarker } from "./canonical-write";
type Writes = Pick<typeof import("node:fs/promises"), "copyFile" | "rename">;
const writes: Writes = { copyFile, rename };
type Update = { input: string; before: Record<string, unknown>; after: Record<string, unknown>; token: string };

export function contentHash(contents: string): string { return createHash("sha256").update(contents).digest("hex"); }
function digest(hashes: Record<string, unknown>, name: string): string {
  const value = hashes[name];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid publication digest for ${name}`);
  return value;
}
async function updateAt(stage: string): Promise<Update> {
  const data = object(JSON.parse(await readFile(join(stage, "metadata-update.json"), "utf8")));
  const input = text(data.input), before = object(data.before), after = object(data.after);
  if (resolve(input) !== input) throw new Error("Publication input must be absolute");
  for (const name of metadataFiles) { digest(before, name); digest(after, name); }
  return { input, before, after, token: contentHash(JSON.stringify({ input, before, after })).slice(0, 24) };
}
function temporary(update: Update, name: string, restore = false): string {
  return join(update.input, `${name}.policy-${update.token}${restore ? "-restore" : ""}.tmp`);
}
async function verify(paths: (name: string) => string, expected: Record<string, unknown>): Promise<void> {
  for (const name of metadataFiles) {
    const contents = await readFile(paths(name), "utf8");
    if (contentHash(contents) !== digest(expected, name)) throw new Error(`Publication checksum differs: ${name}`);
  }
}
async function compatible(update: Update): Promise<boolean> {
  let original = true;
  for (const name of metadataFiles) {
    const current = contentHash(await readFile(join(update.input, name), "utf8"));
    if (current !== digest(update.before, name) && current !== digest(update.after, name)) throw new Error(`Canonical ${name} changed outside this publication; preserve it and reconcile before recovery`);
    if (current !== digest(update.before, name)) original = false;
  }
  return original;
}
async function clearTemporaries(update: Update): Promise<void> {
  for (const name of metadataFiles) {
    await rm(temporary(update, name), { force: true });
    await rm(temporary(update, name, true), { force: true });
  }
}
async function restore(stage: string, update: Update, io: Writes): Promise<void> {
  await verify(name => join(stage, "originals", name), update.before);
  if (!await compatible(update)) {
    for (const name of metadataFiles) await io.copyFile(join(stage, "originals", name), temporary(update, name, true));
    await verify(name => temporary(update, name, true), update.before);
    for (const name of metadataFiles) await io.rename(temporary(update, name, true), join(update.input, name));
  }
  await verify(name => join(update.input, name), update.before);
  await clearTemporaries(update);
  await rm(join(update.input, publicationMarker));
}
async function promote(stage: string, update: Update, io: Writes): Promise<void> {
  await assertNoPublication(update.input);
  await verify(name => join(update.input, name), update.before);
  await verify(name => join(stage, name), update.after);
  await verify(name => join(stage, "originals", name), update.before);
  await writeFile(join(update.input, publicationMarker), JSON.stringify({ stage: resolve(stage), token: update.token }) + "\n", { flag: "wx" });
  try {
    for (const name of metadataFiles) await io.copyFile(join(stage, name), temporary(update, name), constants.COPYFILE_EXCL);
    await verify(name => temporary(update, name), update.after);
    for (const name of metadataFiles) await io.rename(temporary(update, name), join(update.input, name));
    await verify(name => join(update.input, name), update.after);
    await clearTemporaries(update);
    await rm(join(update.input, publicationMarker));
  } catch (error) {
    try { await restore(stage, update, io); }
    catch (recovery) { throw new AggregateError([error, recovery], `Publication failed and recovery is incomplete. Keep canonical writers paused; run policy-metadata.ts --recover ${stage}`); }
    throw error;
  }
}
export async function publishPolicyMetadata(stage: string, io: Writes = writes): Promise<void> {
  const update = await updateAt(stage);
  await withCanonicalWriter(update.input, () => promote(stage, update, io));
}
export async function recoverPolicyMetadata(stage: string): Promise<void> {
  const update = await updateAt(stage);
  await withCanonicalWriter(update.input, async () => {
    const marker = object(JSON.parse(await readFile(join(update.input, publicationMarker), "utf8")));
    if (marker.stage !== resolve(stage) || marker.token !== update.token) throw new Error("Publication marker belongs to a different staging directory");
    await restore(stage, update, writes);
  });
}
