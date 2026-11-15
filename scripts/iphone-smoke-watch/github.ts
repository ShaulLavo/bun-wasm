import { integer, object, revision, timestamp, type Run } from "./model";

export type Request = (path: string) => Promise<unknown>;
const repository = "ShaulLavo/bun-wasm";

function successful(value: unknown, workflow: number, since: string): Run | null {
  const run = object(value);
  if (run.workflow_id !== workflow || run.path !== ".github/workflows/ci.yml" || run.event !== "push" || run.head_branch !== "main") return null;
  if (run.status !== "completed" || run.conclusion !== "success") return null;
  const head = object(run.head_repository);
  if (head.full_name !== repository) return null;
  const createdAt = timestamp(run.created_at);
  if (createdAt < since) return null;
  return { revision: revision(run.head_sha), id: integer(run.id), number: integer(run.run_number), createdAt };
}

function page(value: unknown): { count: number; runs: unknown[] } {
  const data = object(value);
  if (typeof data.total_count !== "number" || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || !Array.isArray(data.workflow_runs)) throw new Error("Invalid GitHub run page");
  return { count: data.total_count, runs: data.workflow_runs };
}

async function windowRuns(request: Request, workflow: number, start: number, end: number): Promise<unknown[]> {
  const filter = encodeURIComponent(`${new Date(start).toISOString()}..${new Date(end).toISOString()}`);
  const path = `repos/${repository}/actions/workflows/${workflow}/runs?event=push&branch=main&status=success&per_page=100&created=${filter}`;
  const first = page(await request(`${path}&page=1`));
  if (first.count > 1000) {
    const middle = Math.floor((start + end) / 2000) * 1000;
    if (middle <= start || middle >= end) throw new Error("GitHub run density exceeds query coverage; no cursor advanced");
    const older = await windowRuns(request, workflow, start, middle);
    return older.concat(await windowRuns(request, workflow, middle, end));
  }
  const runs = first.runs;
  for (let index = 2; index <= Math.ceil(first.count / 100); index++) {
    const next = page(await request(`${path}&page=${index}`));
    runs.push(...next.runs);
  }
  if (runs.length < first.count) throw new Error("Incomplete GitHub success inventory");
  return runs;
}

export async function discover(request: Request, since: string, now: string): Promise<Run[]> {
  const start = timestamp(since), end = timestamp(now);
  if (start > end) throw new Error("Activation is in the future");
  const workflow = object(await request(`repos/${repository}/actions/workflows/ci.yml`));
  if (workflow.path !== ".github/workflows/ci.yml") throw new Error("Wrong CI workflow");
  const id = integer(workflow.id);
  const runs = await windowRuns(request, id, Date.parse(start), Date.parse(end));
  const selected = runs.map(value => successful(value, id, start)).filter(run => run !== null);
  return Array.from(new Map(selected.map(run => [run.id, run])).values());
}
