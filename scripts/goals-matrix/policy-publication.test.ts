import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initialCells } from "./model";
import { campaignDeadlines, deadlinePolicy } from "./deadlines";
import { authoritativePolicy, stagePolicyMetadata } from "./policy-metadata";
import { metadataFiles, publicationMarker, publishPolicyMetadata, recoverPolicyMetadata } from "./policy-publication";
import { withCanonicalWriter } from "./canonical-write";

const owner = { date: "2026-11-11", framework: "next", engine: "spidermonkey", phase: "build", activeLimitMs: 110_000, authorizedLimitMs: 150_000, status: "held-for-integration-diagnosis" };
async function fixture(action: (root: string, stage: string, before: Map<string, string>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-policy-publication-"));
  const table = JSON.stringify({ schema: 2, run: "unchanged", source: { commit: "original" }, deadlines: deadlinePolicy(), cells: initialCells(), campaignPolicy: { schema: 1, ownerDecisions: [owner], retained: "owner metadata" } });
  const originals = [table, table, "# Matrix\n\n## Deadlines\n\nOriginal limits\n\n## Chrome\n\nUnchanged outcomes\n", JSON.stringify({ schema: 1, ownerDecisions: [owner] })];
  const before = new Map(metadataFiles.map((name, index) => [name, originals[index]!]));
  try {
    for (const [name, contents] of before) await writeFile(join(root, name), contents);
    const stage = join(root, "stage");
    await stagePolicyMetadata(root, stage);
    await action(root, stage, before);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function unchanged(root: string, before: Map<string, string>): Promise<void> {
  for (const [name, contents] of before) expect(await readFile(join(root, name), "utf8")).toBe(contents);
}
async function noPublication(root: string): Promise<void> {
  expect((await readdir(root)).filter(name => name === publicationMarker || name.endsWith(".tmp"))).toEqual([]);
}
async function ordinaryMerge(root: string): Promise<Record<string, unknown>> {
  // These are the authority read and BASE spread used by /work/reports/goals/merge-tables.ts.
  const base = JSON.parse(await readFile(join(root, "TABLE.json"), "utf8"));
  const campaignPolicy = JSON.parse(await readFile(join(root, "CAMPAIGN-POLICY.json"), "utf8"));
  const combined = { ...base, campaignPolicy };
  for (const name of ["TABLE.json", "VIEW.json"]) await writeFile(join(root, name), JSON.stringify(combined));
  return combined;
}

test("publication updates the separate authority, preserves owner decisions, and survives the ordinary merge contract", () => fixture(async (root, stage, before) => {
  const original = JSON.parse(before.get("TABLE.json")!);
  await publishPolicyMetadata(stage);
  const authority = JSON.parse(await readFile(join(root, "CAMPAIGN-POLICY.json"), "utf8"));
  expect(authority).toEqual({ schema: 1, ownerDecisions: [owner], retained: "owner metadata", cellDeadlines: campaignDeadlines() });
  const merged = await ordinaryMerge(root);
  expect(merged.campaignPolicy).toEqual(authority);
  delete original.campaignPolicy;
  const { campaignPolicy, ...rest } = merged;
  expect(campaignPolicy).toEqual(authority);
  expect(rest).toEqual(original);
  await noPublication(root);
}));

test("owner decisions from both records survive in authoritative order", () => {
  const older = { date: "2026-11-10", decision: "retain earlier evidence" };
  const result = authoritativePolicy({ schema: 1, ownerDecisions: [owner] }, { ownerDecisions: [older, owner], otherOwnerField: true });
  expect(result.ownerDecisions).toEqual([owner, older]);
  expect(result.otherOwnerField).toBe(true);
});

test("a stale authority or modified staged file is rejected before any promotion", () => fixture(async (root, stage, before) => {
  const authority = join(root, "CAMPAIGN-POLICY.json"), updated = JSON.stringify({ schema: 1, ownerDecisions: [owner], newDecision: true });
  await writeFile(authority, updated);
  await expect(publishPolicyMetadata(stage)).rejects.toThrow("checksum differs");
  before.set("CAMPAIGN-POLICY.json", updated);
  await unchanged(root, before);
  await noPublication(root);
  await writeFile(authority, JSON.stringify({ schema: 1, ownerDecisions: [owner] }));
  before.set("CAMPAIGN-POLICY.json", await readFile(authority, "utf8"));
  await writeFile(join(stage, "VIEW.json"), "modified staging");
  await expect(publishPolicyMetadata(stage)).rejects.toThrow("checksum differs");
  await unchanged(root, before);
  await noPublication(root);
}));

test("a failed copy promotes nothing and leaves every original recoverable", () => fixture(async (root, stage, before) => {
  let promotions = 0;
  await expect(publishPolicyMetadata(stage, {
    async copyFile(source, destination, mode) {
      if (basename(String(source)) === "VIEW.json") throw new Error("injected copy failure");
      await copyFile(source, destination, mode);
    },
    async rename(source, destination) { promotions++; await rename(source, destination); },
  })).rejects.toThrow("injected copy failure");
  expect(promotions).toBe(0);
  await unchanged(root, before);
  await noPublication(root);
}));

test("all temporary copies are verified before promotion", () => fixture(async (root, stage, before) => {
  let promotions = 0;
  await expect(publishPolicyMetadata(stage, {
    async copyFile(source, destination, mode) {
      await copyFile(source, destination, mode);
      if (basename(String(source)) === "VIEW.json") await writeFile(destination, "corrupt copied bytes");
    },
    async rename(source, destination) { promotions++; await rename(source, destination); },
  })).rejects.toThrow("checksum differs");
  expect(promotions).toBe(0);
  await unchanged(root, before);
  await noPublication(root);
}));

test("a failed rename restores the complete original set before returning the failure", () => fixture(async (root, stage, before) => {
  let failed = false;
  await expect(publishPolicyMetadata(stage, { copyFile, async rename(source, destination) {
    if (failed || basename(String(destination)) !== "VIEW.json") return rename(source, destination);
    failed = true;
    throw new Error("injected rename failure");
  } })).rejects.toThrow("injected rename failure");
  await unchanged(root, before);
  await noPublication(root);
  await publishPolicyMetadata(stage);
  expect(JSON.parse(await readFile(join(root, "TABLE.json"), "utf8")).campaignPolicy.cellDeadlines).toEqual(campaignDeadlines());
}));

async function interruptedPublication(stage: string): Promise<void> {
  await expect(publishPolicyMetadata(stage, { copyFile, async rename(source, destination) {
    if (basename(String(destination)) === "VIEW.json" || String(source).includes("-restore.tmp")) throw new Error("injected promotion and recovery failure");
    await rename(source, destination);
  } })).rejects.toThrow("recovery is incomplete");
}
test("failed rollback retains a marker and explicit recovery restores all originals", () => fixture(async (root, stage, before) => {
  await interruptedPublication(stage);
  expect(JSON.parse(await readFile(join(root, publicationMarker), "utf8")).stage).toBe(stage);
  await expect(stagePolicyMetadata(root, join(root, "new-stage"))).rejects.toThrow("unfinished campaign policy publication");
  await recoverPolicyMetadata(stage);
  await unchanged(root, before);
  await noPublication(root);
}));

test("recovery refuses to overwrite unrelated canonical changes", () => fixture(async (root, stage) => {
  await interruptedPublication(stage);
  const changed = "a later canonical writer's evidence";
  await writeFile(join(root, "TABLE.json"), changed);
  await expect(recoverPolicyMetadata(stage)).rejects.toThrow("changed outside this publication");
  expect(await readFile(join(root, "TABLE.json"), "utf8")).toBe(changed);
}));

test("publication shares the canonical writer lock and releases it after completion", () => fixture(async (root, stage) => {
  const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const first = withCanonicalWriter(root, async () => { held.resolve(); await release.promise; });
  await held.promise;
  expect(Bun.spawnSync(["flock", "--nonblock", join(root, ".canonical-writer.lock"), "true"]).exitCode).toBe(1);
  const applying = publishPolicyMetadata(stage);
  release.resolve();
  await first;
  await applying;
  expect(Bun.spawnSync(["flock", "--nonblock", join(root, ".canonical-writer.lock"), "true"]).exitCode).toBe(0);
}));
