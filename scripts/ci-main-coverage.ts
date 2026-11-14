import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { nativeCheckInputsAt } from "./ci-check-inputs";
import { selectChanges, selectionOutput, type CheckSelection } from "./ci-changes";

export const coverageMarker = "Resolve cumulative main coverage v1";
const workflowPath = ".github/workflows/ci.yml";
const fullSelection: CheckSelection = { rust: true, jsc: true, shared: true, shared_native: true };
const limits = { edges: 64, pages: 80, jobInspections: 24, milliseconds: 30_000 };

type Coverage =
  | { kind: "verified"; base: string; head: string; run: number; edges: number; selection: CheckSelection }
  | { kind: "full"; head: string; reason: string; selection: CheckSelection };

interface CoverageInput {
  head: string;
  run: number;
  request: (path: string) => Promise<unknown>;
  bounds?: typeof limits;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Actions response object");
  return Object.fromEntries(Object.entries(value));
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid Actions ID or attempt");
  return value;
}

function commit(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error("Invalid coverage commit");
  return value;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ancestors(head: string, maximum: number): string[] {
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") throw new Error("Incomplete shallow history");
  if (git(["rev-parse", "--verify", `${head}^{commit}`]) !== head) throw new Error("Missing immutable head");
  return git(["rev-list", "--first-parent", `--max-count=${maximum + 1}`, head]).split("\n").map(commit);
}

function runIdentity(value: unknown) {
  const run = record(value);
  return {
    id: positiveId(run.id), workflow: positiveId(run.workflow_id), path: run.path,
    event: run.event, branch: run.head_branch, head: commit(run.head_sha),
    status: run.status, conclusion: run.conclusion, attempt: positiveId(run.run_attempt),
  };
}

function mainWorkflow(run: ReturnType<typeof runIdentity>, workflow: number): boolean {
  return run.workflow === workflow && run.path === workflowPath && run.event === "push" && run.branch === "main";
}

function markedQuality(value: unknown, head: string): boolean {
  const job = record(value);
  if (job.name !== "Source quality" || job.head_sha !== head || job.status !== "completed" || job.conclusion !== "success") return false;
  if (!Array.isArray(job.steps)) throw new Error("Missing Actions job steps");
  return job.steps.some(value => {
    const step = record(value);
    return step.name === coverageMarker && step.status === "completed" && step.conclusion === "success";
  });
}

function pageItems(value: unknown, key: string): { items: unknown[]; total: number } {
  const page = record(value);
  const items = page[key];
  if (!Array.isArray(items) || typeof page.total_count !== "number" || !Number.isSafeInteger(page.total_count) || page.total_count < items.length)
    throw new Error("Invalid Actions page");
  return { items, total: page.total_count };
}

function selectionAcross(chain: readonly string[], distance: number, checkTime: () => void): CheckSelection {
  const cache = new Map<string, string[]>();
  const inputsAt: typeof nativeCheckInputsAt = (ref, selection = {}) => {
    checkTime();
    const key = `${ref}:${JSON.stringify(selection)}`;
    let inputs = cache.get(key);
    if (!inputs) { inputs = nativeCheckInputsAt(ref, selection); cache.set(key, inputs); }
    return inputs;
  };
  const selection: CheckSelection = { rust: false, jsc: false, shared: false, shared_native: false };
  for (let index = distance; index > 0; index--) {
    const base = chain[index];
    const head = chain[index - 1];
    if (!base || !head) throw new Error("Incomplete first-parent edge");
    checkTime();
    const edge = selectChanges(base, head, false, inputsAt);
    for (const key of ["rust", "jsc", "shared", "shared_native"] as const) selection[key] ||= edge[key];
  }
  checkTime();
  return selection;
}

export async function mainCoverage(input: CoverageInput): Promise<Coverage> {
  const bounds = input.bounds ?? limits;
  const now = input.now ?? Date.now;
  const deadline = now() + bounds.milliseconds;
  let pages = 0;
  let inspections = 0;
  const checkTime = () => { if (now() >= deadline) throw new Error("Coverage lookup time bound reached"); };
  const request = async (path: string) => {
    checkTime();
    if (++pages > bounds.pages) throw new Error("Coverage API page bound reached");
    const result = await input.request(path);
    checkTime();
    return result;
  };
  const hasMarker = async (run: ReturnType<typeof runIdentity>) => {
    if (++inspections > bounds.jobInspections) throw new Error("Coverage job inspection bound reached");
    for (let page = 1; ; page++) {
      const jobs = pageItems(await request(`actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`), "jobs");
      if (jobs.items.some(job => markedQuality(job, run.head))) return true;
      if (page * 100 >= jobs.total) return false;
      if (jobs.items.length !== 100) throw new Error("Incomplete Actions jobs page");
    }
  };
  try {
    const head = commit(input.head);
    positiveId(input.run);
    const chain = ancestors(head, bounds.edges);
    const current = runIdentity(await request(`actions/runs/${input.run}`));
    if (current.id !== input.run || current.head !== head || !mainWorkflow(current, current.workflow)) throw new Error("Current run is not immutable main CI");
    for (let distance = 1; distance < chain.length; distance++) {
      const ancestor = chain[distance];
      if (!ancestor) throw new Error("Missing ancestor");
      const baseline = await baselineAt(ancestor, current, request, hasMarker);
      if (!baseline) continue;
      return { kind: "verified", base: ancestor, head, run: baseline.id, edges: distance, selection: selectionAcross(chain, distance, checkTime) };
    }
    throw new Error(chain.length > bounds.edges ? "Coverage first-parent edge bound reached" : "No successful marked main baseline");
  } catch (error) {
    return { kind: "full", head: input.head, reason: error instanceof Error ? error.message : "Coverage lookup failed", selection: { ...fullSelection } };
  }
}

async function baselineAt(
  head: string,
  current: ReturnType<typeof runIdentity>,
  request: CoverageInput["request"],
  hasMarker: (run: ReturnType<typeof runIdentity>) => Promise<boolean>,
): Promise<ReturnType<typeof runIdentity> | undefined> {
  for (let page = 1; ; page++) {
    const query = `branch=main&event=push&status=success&head_sha=${head}&per_page=100&page=${page}`;
    const runs = pageItems(await request(`actions/workflows/${current.workflow}/runs?${query}`), "workflow_runs");
    for (const value of runs.items) {
      const run = runIdentity(value);
      if (run.id === current.id || run.head !== head || !mainWorkflow(run, current.workflow) || run.status !== "completed" || run.conclusion !== "success") continue;
      if (await hasMarker(run)) return run;
    }
    if (page * 100 >= runs.total) return undefined;
    if (runs.items.length !== 100) throw new Error("Incomplete Actions runs page");
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function runCli(): Promise<void> {
  if (requiredEnv("GITHUB_EVENT_NAME") !== "push" || requiredEnv("GITHUB_REF") !== "refs/heads/main") throw new Error("Cumulative selection is main-push only");
  const head = commit(process.argv[2]);
  if (head !== requiredEnv("GITHUB_SHA") || git(["rev-parse", "HEAD"]) !== head) throw new Error("Coverage head differs from immutable checkout");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const signal = AbortSignal.timeout(limits.milliseconds);
  const result = await mainCoverage({
    head, run: Number(requiredEnv("GITHUB_RUN_ID")),
    request: async path => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        headers: { Authorization: `Bearer ${requiredEnv("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal,
      });
      if (!response.ok) throw new Error(`Actions read failed with HTTP ${response.status}`);
      return response.json();
    },
  });
  const summary = result.kind === "verified"
    ? `Cumulative main coverage v1: run ${result.run}, base ${result.base}, head ${result.head}, ${result.edges} first-parent edges.`
    : `Cumulative main coverage v1: all families selected for head ${result.head}. ${result.reason}.`;
  console.error(summary);
  const output = selectionOutput(result.selection);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n\`\`\`\n${output}\n\`\`\`\n`);
  console.log(`selection<<ci-main-selection\n${output}\nci-main-selection`);
}

if (import.meta.main) await runCli();
