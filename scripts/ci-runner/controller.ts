import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { github } from "./github.ts";
import { root } from "./host.ts";
import { activeRunStatuses, eligibleQueuedJob, targetsPcPool } from "./policy.ts";
import { launchRunner } from "./vm.ts";

async function queuedJob(): Promise<number | undefined> {
  for (const status of activeRunStatuses) {
    const runs: unknown = await github(`/repos/ShaulLavo/bun-wasm/actions/runs?status=${status}&per_page=20`);
    if (typeof runs !== "object" || runs === null || !("workflow_runs" in runs) || !Array.isArray(runs.workflow_runs)) throw new Error("Invalid run inventory");
    const match = await jobInRuns(runs.workflow_runs);
    if (match) return match;
  }
  return undefined;
}

async function jobInRuns(runs: unknown[]): Promise<number | undefined> {
  for (const run of runs) {
    if (typeof run !== "object" || run === null || !("id" in run) || typeof run.id !== "number") throw new Error("Invalid run ID");
    const result: unknown = await github(`/repos/ShaulLavo/bun-wasm/actions/runs/${run.id}/jobs?per_page=100`);
    if (typeof result !== "object" || result === null || !("jobs" in result) || !Array.isArray(result.jobs)) throw new Error("Invalid job inventory");
    const match = await jobInList(result.jobs);
    if (match) return match;
  }
  return undefined;
}

async function jobInList(jobs: unknown[]): Promise<number | undefined> {
  for (const job of jobs) {
    if (typeof job !== "object" || job === null || !("id" in job) || !("status" in job) || job.status !== "queued" || typeof job.id !== "number" || !("labels" in job) || !targetsPcPool(job.labels)) continue;
    try { await eligibleQueuedJob(github, job.id); return job.id; } catch { continue; }
  }
  return undefined;
}

async function assertReviewed(): Promise<void> {
  const accepted = (await readFile(`${root}/reviewed-source.sha256`, "utf8")).trim();
  if (accepted !== await sourceDigest()) throw new Error("Independent guard/containment review must accept these exact sources first");
}

async function serve(): Promise<void> {
  for (;;) {
    await assertReviewed();
    try {
      const jobId = existsSync("/home/shaul/.local/state/machine-fleet/owner-busy") ? undefined : await queuedJob();
      if (jobId) await launchRunner("browser", await eligibleQueuedJob(github, jobId));
    } catch { process.stderr.write("PC CI cycle ended with an error; unconfirmed cleanup is retained.\n"); }
    await delay(30_000);
  }
}

async function sourceDigest(): Promise<string> {
  const directory = new URL(".", import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith(".ts") || file.endsWith(".service")).sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(await readFile(new URL(file, directory))).update("\0");
  return hash.digest("hex");
}

async function main(): Promise<void> {
  if (process.argv[2] === "digest") {
    process.stdout.write(`${await sourceDigest()}\n`);
    return;
  }
  if (process.argv[2] === "serve") return serve();
  const profile = process.argv[3];
  const jobId = Number(process.argv[4]);
  if (process.argv[2] !== "run" || (profile !== "native" && profile !== "browser") || !Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("Expected digest, or run native|browser JOB_ID");
  await assertReviewed();
  const admission = await eligibleQueuedJob(github, jobId);
  await launchRunner(profile, admission);
}

main().catch(() => { process.stderr.write("PC runner controller refused or failed the session; routing remains unchanged.\n"); process.exitCode = 1; });
