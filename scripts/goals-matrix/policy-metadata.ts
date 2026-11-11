import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { campaignDeadlines } from "./deadlines";
import { object } from "./evidence";
import { deadlineMarkdown } from "./report";
import { inventory } from "./catalog";

export function policyMetadata(contents: string): string {
  const report = object(JSON.parse(contents));
  if (report.schema !== 2 || !Array.isArray(report.cells) || report.cells.length !== inventory().length) throw new Error("Expected canonical schema 2 table");
  return JSON.stringify({ ...report, campaignPolicy: campaignDeadlines() }, null, 2) + "\n";
}
export function policyMarkdown(contents: string): string {
  const start = contents.indexOf("## Deadlines\n"), end = contents.indexOf("\n## ", start + 1);
  if (start < 0 || end < 0 || contents.indexOf("## Deadlines\n", start + 1) >= 0) throw new Error("Expected one bounded canonical Deadlines section");
  const note = "This section describes the reviewed policy for future campaigns. Historical attempts, their original deadlines and source identities remain unchanged in TABLE.json and VIEW.json.\n\n";
  const section = deadlineMarkdown(campaignDeadlines()).replace("## Deadlines\n\n", "## Deadlines\n\n" + note);
  return contents.slice(0, start) + section + "\n" + contents.slice(end + 1);
}
export async function stagePolicyMetadata(input: string, output: string): Promise<void> {
  if (resolve(input) === resolve(output)) throw new Error("Stage metadata in a new directory; never overwrite canonical inputs");
  const names = ["TABLE.json", "VIEW.json", "TABLE.md"];
  const originals = await Promise.all(names.map(name => readFile(join(input, name), "utf8")));
  if (originals[0] !== originals[1]) throw new Error("Canonical TABLE.json and VIEW.json differ; restage after their merge finishes");
  const generated = originals.map((contents, index) => index === 2 ? policyMarkdown(contents) : policyMetadata(contents));
  const before = Object.fromEntries(names.map((name, index) => [name, createHash("sha256").update(originals[index]!).digest("hex")]));
  const after = Object.fromEntries(names.map((name, index) => [name, createHash("sha256").update(generated[index]!).digest("hex")]));
  await mkdir(output);
  for (const [index, name] of names.entries()) await writeFile(join(output, name), generated[index]!);
  await writeFile(join(output, "metadata-update.json"), JSON.stringify({ input: resolve(input), before, after,
    application: "Coordinator only, after review/merge. Pause canonical merges, verify all three before hashes, then replace these three files. If any hash changed, restage. Resume merges afterward. Keep original deadlines and every cell unchanged; campaignPolicy describes future execution." }, null, 2) + "\n");
  await writeFile(join(output, "before.sha256"), names.map(name => `${before[name]}  ${join(resolve(input), name)}\n`).join(""));
  await writeFile(join(output, "after.sha256"), names.map(name => `${after[name]}  ${join(resolve(input), name)}\n`).join(""));
}
if (import.meta.main) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("Usage: bun scripts/goals-matrix/policy-metadata.ts CANONICAL_DIRECTORY NEW_STAGING_DIRECTORY");
  await stagePolicyMetadata(input, output);
}
