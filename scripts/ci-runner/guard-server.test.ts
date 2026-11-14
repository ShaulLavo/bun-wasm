import { expect, test } from "bun:test";
import { createGuard } from "./guard-server.ts";
import type { GitHubApi } from "./policy.ts";

function authority() {
  const headSha = "b".repeat(40);
  const repo = { full_name: "ShaulLavo/bun-wasm" };
  const job = { id: 707, run_id: 505, run_attempt: 2, head_sha: headSha, status: "in_progress", conclusion: null, runner_id: 303, labels: ["self-hosted", "linux", "x64", "pc", "bun-wasm"] };
  const run = { id: 505, run_attempt: 2, head_sha: headSha, status: "in_progress", conclusion: null, repository: repo, head_repository: repo, event: "pull_request", pull_requests: [{ number: 606 }] };
  const pr = { state: "open", head: { repo, sha: headSha }, base: { repo } };
  const inventory = { total_count: 2, jobs: [job, { ...job, id: 708, runner_id: 0, status: "queued" }] };
  const calls: string[] = [];
  const api: GitHubApi = async path => {
    calls.push(path);
    if (path.endsWith("/actions/runs/505/attempts/2/jobs?per_page=100")) return structuredClone(inventory);
    if (path.endsWith("/actions/jobs/707")) return structuredClone(job);
    if (path.endsWith("/actions/runs/505")) return structuredClone(run);
    if (path.endsWith("/pulls/606")) return structuredClone(pr);
    throw new Error("No authoritative record at hint");
  };
  return { api, job, run, pr, inventory, calls, headSha };
}

async function withGuard(api: GitHubApi, check: (control: {
  guard: Awaited<ReturnType<typeof createGuard>>;
  post: (body: unknown, token?: string, signal?: AbortSignal) => Promise<Response | null>;
  stopped: Promise<void>;
  stopCount: () => number;
}) => Promise<void>, timeoutMs = 2000) {
  const stopped = Promise.withResolvers<void>();
  let stopCount = 0;
  const guard = await createGuard({ session: { runnerId: 303 }, api, timeoutMs, stopVm: async () => { stopCount++; stopped.resolve(); } });
  const url = guard.url.replace("10.0.2.2", "127.0.0.1");
  const post = async (body: unknown, token = guard.token, signal = AbortSignal.timeout(3000)) => fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal,
  }).catch(() => null);
  try {
    await check({ guard, post, stopped: stopped.promise, stopCount: () => stopCount });
  } finally {
    await guard.close();
  }
}

const hint = { runId: "505", attempt: "2" };

test("authenticated hook releases only the API-bound assignment and retains public IDs", async () => {
  const f = authority();
  await withGuard(f.api, async ({ guard, post, stopCount }) => {
    const response = await post(hint);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ approved: true });
    expect(stopCount()).toBe(0);
    expect(guard.evidence).toEqual({ authenticated: true, apiChecked: true, approved: true, decision: "approved", runnerId: 303,
      assignment: { jobId: 707, runId: 505, attempt: 2, headSha: f.headSha, runnerId: 303 } });
    expect(f.calls).toHaveLength(8);
  });
});

test("invalid authentication stops before any authoritative API call", async () => {
  const f = authority();
  await withGuard(f.api, async ({ guard, post, stopped, stopCount }) => {
    expect(await post(hint, "wrong")).toBeNull();
    await stopped;
    expect(stopCount()).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(guard.evidence.authenticated).toBe(false);
    expect(guard.evidence.approved).toBe(false);
  });
});

test.each([null, {}, { runId: "505", attempt: "0" }, { runId: "../505", attempt: "2" }, { runId: 505, attempt: 2 }, { runId: "9007199254740993", attempt: "2" }])
  ("invalid hints fail-stop before API lookup: %j", async body => {
    const f = authority();
    await withGuard(f.api, async ({ guard, post, stopped }) => {
      expect(await post(body)).toBeNull();
      await stopped;
      expect(f.calls).toHaveLength(0);
      expect(guard.evidence.approved).toBe(false);
    });
  });

test.each(["wrong-runner", "fork", "manual", "stale", "cancelled", "attempt", "ambiguous", "incomplete", "arbitrary-hint", "offline"])
  ("authenticated %s lookup stops without an approval response", async mode => {
    const f = authority();
    if (mode === "wrong-runner") f.job.runner_id = 999;
    if (mode === "fork") f.pr.head.repo = { full_name: "fork/bun-wasm" };
    if (mode === "manual") f.run.event = "workflow_dispatch";
    if (mode === "stale") f.pr.head.sha = "c".repeat(40);
    if (mode === "cancelled") f.run.status = "completed";
    if (mode === "attempt") f.run.run_attempt++;
    if (mode === "ambiguous") f.inventory.jobs.push({ ...f.job, id: 709 });
    if (mode === "ambiguous") f.inventory.total_count++;
    if (mode === "incomplete") f.inventory.total_count++;
    const api: GitHubApi = mode === "offline" ? async () => { throw new Error("offline"); } : f.api;
    await withGuard(api, async ({ guard, post, stopped, stopCount }) => {
      expect(await post(mode === "arbitrary-hint" ? { runId: "999", attempt: "2" } : hint)).toBeNull();
      await stopped;
      expect(stopCount()).toBe(1);
      expect(guard.evidence).toMatchObject({ authenticated: true, apiChecked: true, approved: false, assignment: null, decision: "policy" });
    });
  });

test("timeout during authoritative lookup stops and a late result cannot release", async () => {
  const f = authority();
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const api: GitHubApi = async path => { entered.resolve(); await pending.promise; return f.api(path); };
  await withGuard(api, async ({ guard, post, stopped, stopCount }) => {
    const response = post(hint);
    await entered.promise;
    await stopped;
    pending.resolve();
    expect(await response).toBeNull();
    expect(stopCount()).toBe(1);
    expect(guard.evidence).toMatchObject({ apiChecked: true, approved: false, assignment: null, decision: "timeout" });
  }, 100);
});

test("hook disconnect during verification stops without release", async () => {
  const f = authority();
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const api: GitHubApi = async path => { entered.resolve(); await pending.promise; return f.api(path); };
  await withGuard(api, async ({ guard, post, stopped }) => {
    const controller = new AbortController();
    const response = post(hint, guard.token, controller.signal);
    await entered.promise;
    controller.abort();
    await stopped;
    pending.resolve();
    expect(await response).toBeNull();
    expect(guard.evidence).toMatchObject({ approved: false, assignment: null, decision: "transport" });
  });
});

test("a second hook request during verification stops the session", async () => {
  const f = authority();
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const api: GitHubApi = async path => { entered.resolve(); await pending.promise; return f.api(path); };
  await withGuard(api, async ({ guard, post, stopped, stopCount }) => {
    const first = post(hint);
    await entered.promise;
    const second = post(hint);
    await stopped;
    pending.resolve();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(stopCount()).toBe(1);
    expect(guard.evidence).toMatchObject({ approved: false, assignment: null, decision: "authentication" });
  });
});
