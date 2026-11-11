import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { campaignDeadlines } from "./deadlines";
import { object } from "./evidence";
import { deadlineMarkdown } from "./report";
import { inventory } from "./catalog";
import { contentHash, metadataFiles, publishPolicyMetadata, recoverPolicyMetadata } from "./policy-publication";
import { assertNoPublication } from "./canonical-write";

export function authoritativePolicy(authority: unknown, previous: unknown): Record<string, unknown> {
  const policy = object(authority), prior = previous === undefined ? {} : object(previous);
  if (policy.schema !== 1 || !Array.isArray(policy.ownerDecisions)) throw new Error("Expected authoritative campaign schema 1 owner decisions");
  if (prior.ownerDecisions !== undefined && !Array.isArray(prior.ownerDecisions)) throw new Error("Invalid existing owner decisions");
  const decisions: unknown[] = policy.ownerDecisions.concat(prior.ownerDecisions ?? []);
  const unique = new Map<string, unknown>();
  for (const decision of decisions) {
    const key = JSON.stringify(decision);
    if (key === undefined) throw new Error("Invalid owner decision");
    unique.set(key, decision);
  }
  return { ...prior, ...policy, ownerDecisions: Array.from(unique.values()), cellDeadlines: campaignDeadlines() };
}
export function policyMetadata(contents: string, campaignPolicy: Record<string, unknown>): string {
  const report = object(JSON.parse(contents));
  if (report.schema !== 2 || !Array.isArray(report.cells) || report.cells.length !== inventory().length) throw new Error("Expected canonical schema 2 table");
  return JSON.stringify({ ...report, campaignPolicy }, null, 2) + "\n";
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
  await assertNoPublication(input);
  const names = metadataFiles;
  const originals = await Promise.all(names.map(name => readFile(join(input, name), "utf8")));
  if (originals[0] !== originals[1]) throw new Error("Canonical TABLE.json and VIEW.json differ; restage after their merge finishes");
  const authority = authoritativePolicy(JSON.parse(originals[3]!), object(JSON.parse(originals[0]!)).campaignPolicy);
  const generated = originals.map((contents, index) => index === 2 ? policyMarkdown(contents) : index === 3 ? JSON.stringify(authority, null, 2) + "\n" : policyMetadata(contents, authority));
  const before = Object.fromEntries(names.map((name, index) => [name, contentHash(originals[index]!)]));
  const after = Object.fromEntries(names.map((name, index) => [name, contentHash(generated[index]!)]));
  await mkdir(output);
  await mkdir(join(output, "originals"));
  for (const [index, name] of names.entries()) await writeFile(join(output, name), generated[index]!);
  for (const [index, name] of names.entries()) await writeFile(join(output, "originals", name), originals[index]!);
  await writeFile(join(output, "metadata-update.json"), JSON.stringify({ input: resolve(input), before, after,
    application: "Coordinator only after review/merge. Install the shared canonical writer lock in the merge helper, then use --apply. All four before hashes must match; otherwise restage. Failed promotion restores originals. An interrupted or failed recovery leaves a marker and must use --recover before merges resume." }, null, 2) + "\n");
  await writeFile(join(output, "before.sha256"), names.map(name => `${before[name]}  ${join(resolve(input), name)}\n`).join(""));
  await writeFile(join(output, "after.sha256"), names.map(name => `${after[name]}  ${join(resolve(input), name)}\n`).join(""));
}
if (import.meta.main) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error("Usage: policy-metadata.ts CANONICAL_DIRECTORY NEW_STAGING_DIRECTORY | --apply STAGING_DIRECTORY | --recover STAGING_DIRECTORY");
  if (input === "--apply") await publishPolicyMetadata(output);
  else if (input === "--recover") await recoverPolicyMetadata(output);
  else await stagePolicyMetadata(input, output);
}
