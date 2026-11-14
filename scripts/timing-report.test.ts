import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReport, compareSamples, githubRequest, parseSample, parseTimingLog, readBounded, summary, trustedRun, type Transport } from "./timing-report.ts";
import { TIMING_PREFIX, timingWorkloads, type TimingSample } from "./timing-observation.ts";
import { needsJsc, needsRust, needsSharedNative, needsSharedSysroot } from "./ci-changes.ts";

const sha = "a".repeat(40);
const run = { id: 1, run_attempt: 1, event: "push", head_branch: "main", status: "completed", conclusion: "success", head_repository: { full_name: "ShaulLavo/bun-wasm" }, head_sha: sha, path: ".github/workflows/ci.yml" };
function sample(metric: TimingSample["metric"] = "diagnostic-controller-progress", elapsedMs = 4): TimingSample {
  return { schema: 1, metric, workload: timingWorkloads[metric], sourceSha: sha, elapsedMs, outcome: "pass",
    environment: { os: "linux", arch: "x64", kernel: "6.8", cpu: "fixture CPU", cores: 4, runner: "github-hosted", image: "ubuntu24", imageVersion: "20261114.1", runtime: "Bun 1.4.4; Node 24", browser: metric === "http-stream-cancel" ? "Chromium 150" : "none" } };
}
const line = (value: TimingSample) => TIMING_PREFIX + JSON.stringify(value);
const bounded = (response: Response) => readBounded(response, 1024);

test("the emitter and parser share the exact schema", async () => {
  const output = execFileSync(process.execPath, ["-e", 'import { emitTiming } from "./scripts/timing-observation.ts"; emitTiming("diagnostic-controller-progress", 3.25);'], {
    cwd: new URL("..", import.meta.url), env: { ...process.env, GITHUB_SHA: sha }, encoding: "utf8", timeout: 10_000,
  });
  const result = await parseTimingLog(new Response(output), sha);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ elapsedMs: 3.25, outcome: "pass", workload: timingWorkloads["diagnostic-controller-progress"], sourceSha: sha });
  expect(result[0]?.environment.runtime).toContain("Bun ");
});

test("streamed logs retain only timestamped bounded metric rows across UTF-8 chunks", async () => {
  const bytes = new TextEncoder().encode(`ordinary log é\n2026-11-14T00:00:00Z ${line(sample())}\nmore output\n`);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  expect(await parseTimingLog(new Response(stream), sha)).toEqual([sample()]);
  expect(await parseTimingLog(new Response("no measurements"), sha)).toEqual([]);
});

test("invalid schema, outcome, source, workload, numbers and environment are rejected", () => {
  for (const mutation of [
    { schema: 2 }, { metric: "__proto__" }, { outcome: "fail" }, { sourceSha: "wrong" }, { workload: "changed" },
    { elapsedMs: -1 }, { elapsedMs: NaN }, { elapsedMs: Infinity }, { environment: {} }, { environment: { ...sample().environment, cores: 0 } },
  ]) expect(() => parseSample({ ...sample(), ...mutation })).toThrow();
});

test("malformed, cross-source, too many and oversized metric rows fail visibly", async () => {
  for (const log of [TIMING_PREFIX + "{bad", line(sample()), Array.from({ length: 9 }, () => line(sample())).join("\n"), line(sample()) + " ".repeat(16_384)]) {
    const expectedSha = log === line(sample()) ? "b".repeat(40) : sha;
    await expect(parseTimingLog(new Response(log), expectedSha)).rejects.toThrow();
  }
});

test("body limits cancel real streams, including a dishonest content length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } });
  await expect(readBounded(new Response(stream, { headers: { "content-length": "1" } }), 1024)).rejects.toThrow("size limit");
  expect(cancelled).toBe(true);
  await expect(readBounded(new Response("abc", { headers: { "content-length": "3000" } }), 1024)).rejects.toThrow("size limit");
});

test("main success trust excludes forks, PRs, dispatches and failed CI", () => {
  expect(trustedRun(run)).toEqual({ id: 1, run_attempt: 1, head_sha: sha });
  for (const mutation of [{ event: "pull_request" }, { event: "workflow_dispatch" }, { head_branch: "topic" }, { conclusion: "failure" }, { status: "in_progress" },
    { head_repository: { full_name: "fork/bun-wasm" } }, { path: ".github/workflows/other.yml" }, { run_attempt: 0 }, { head_sha: "bad" }]) {
    expect(() => trustedRun({ ...run, ...mutation })).toThrow();
  }
});

test("trends report slower samples without a speed gate and require matching environments", () => {
  expect(compareSamples([sample(undefined, 100_000)], [sample()])[0]).toMatchObject({ status: "comparable", changeMs: 99_996 });
  expect(compareSamples([], [sample()])[0]?.status).toBe("missing");
  expect(compareSamples([sample()], [])[0]?.status).toBe("first observation");
  for (const field of ["os", "arch", "kernel", "cpu", "cores", "runner", "image", "imageVersion", "runtime", "browser"] as const) {
    const old = sample();
    const changed = { ...old, environment: { ...old.environment, [field]: field === "cores" ? 99 : "other" } };
    expect(compareSamples([changed], [old])[0]?.status).toBe("incomparable");
  }
  const unknown = { ...sample(), environment: { ...sample().environment, imageVersion: "unknown" } };
  expect(compareSamples([unknown], [unknown])[0]?.status).toBe("incomparable");
  expect(summary(compareSamples([], []), ["missing fixture"])).toContain("not product benchmarks");
});

test("signed redirects never receive credentials and every request is bounded", async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const transport: Transport = async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: "https://signed.example/log?secret=private" } }) : new Response("done");
  };
  expect(new TextDecoder().decode(await githubRequest("https://api.github.com/test", "private-token", bounded, transport))).toBe("done");
  expect(new Headers(requests[0]?.options?.headers).get("authorization")).toBe("Bearer private-token");
  expect(new Headers(requests[1]?.options?.headers).has("authorization")).toBe(false);
  expect(requests[1]?.options?.redirect).toBe("error");
  expect(requests.every(request => request.options?.signal instanceof AbortSignal)).toBe(true);
});

test("a real stalled HTTP response aborts, retries twice and redacts errors", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("pending")); } })) });
  let requests = 0;
  const transport: Transport = (_url, options) => { requests++; return fetch(server.url, options); };
  try {
    await expect(githubRequest("https://api.github.com/test", "private-token", bounded, transport, 25)).rejects.toThrow("failed after two bounded attempts");
    expect(requests).toBe(2);
  } finally { await server.stop(true); }
}, 10_000);

test("a transient failed GET retries while invalid redirect schemes remain bounded", async () => {
  let requests = 0;
  const retry: Transport = async () => ++requests === 1 ? new Response("unavailable", { status: 503 }) : new Response("ok");
  expect(new TextDecoder().decode(await githubRequest("https://api.github.com/test", "token", bounded, retry))).toBe("ok");
  expect(requests).toBe(2);
  requests = 0;
  const redirect: Transport = async () => { requests++; return new Response(null, { status: 302, headers: { location: "http://insecure.example/secret" } }); };
  await expect(githubRequest("https://api.github.com/test", "token", bounded, redirect)).rejects.toThrow("failed after two");
  expect(requests).toBe(2);
});

function reportTransport(archive?: Uint8Array, badLog = false, diagnostic = line(sample())): Transport {
  return async url => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/actions/runs/1")) return Response.json(run);
    if (path.endsWith("/jobs")) return Response.json({ total_count: 3, jobs: [{ name: "Web host unit and types", id: 11, conclusion: "success" }, { name: "Web browser (20-preview)", id: 12, conclusion: "success" }, { name: "Rust", id: 13, conclusion: "success" }] });
    if (path.endsWith("/jobs/11/logs")) return new Response(badLog ? TIMING_PREFIX + "broken" : diagnostic);
    if (path.endsWith("/jobs/12/logs")) return new Response(line(sample("http-stream-cancel", 260)));
    if (path.endsWith("/runs")) return Response.json({ workflow_runs: archive ? [{ id: 8, event: "workflow_run", head_branch: "main" }] : [] });
    if (path.endsWith("/artifacts")) return Response.json({ artifacts: [{ name: "ci-timing-report", expired: false, id: 20, size_in_bytes: archive?.length }] });
    if (path.endsWith("/20/zip") && archive) return new Response(Buffer.from(archive));
    throw new Error("Unexpected request; large/native logs must never be fetched");
  };
}

test("the collector reuses only known Web logs and explicitly reports missing rows", async () => {
  const first = await collectReport({ workflow_run: run }, "token", 9, reportTransport());
  expect(first.samples).toEqual([sample(), sample("http-stream-cancel", 260)]);
  expect(first.trends.every(row => row.status === "first observation")).toBe(true);
  expect(first.issues).toContain("No previous successful report in the last ten reports");
  const broken = await collectReport({ workflow_run: run }, "token", 9, reportTransport(undefined, true));
  expect(broken.trends[0]?.status).toBe("missing");
  expect(broken.issues).toContain("Could not read valid bounded timing rows: Web host unit and types");
});

test("the previous compact artifact is decompressed with bounds and compares real raw samples", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-timing-artifact-test-"));
  try {
    writeFileSync(join(scratch, "timing-report.json"), JSON.stringify({ schema: 1, samples: [sample(undefined, 2), sample("http-stream-cancel", 250)] }));
    execFileSync("zip", ["-q", "report.zip", "timing-report.json"], { cwd: scratch, timeout: 5_000 });
    const result = await collectReport({ workflow_run: run }, "token", 9, reportTransport(readFileSync(join(scratch, "report.zip"))));
    expect(result.issues).toEqual([]);
    expect(result.trends.map(row => row.changeMs)).toEqual([2, 10]);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the complete report retains only metric fields from current logs and previous artifacts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-timing-fields-test-"));
  const extra = { ...sample(), privateNote: "unrelated-top-level-sentinel", environment: { ...sample().environment, rawLog: "unrelated-environment-sentinel" } };
  try {
    writeFileSync(join(scratch, "timing-report.json"), JSON.stringify({ schema: 1, samples: [extra, sample("http-stream-cancel", 250)] }));
    execFileSync("zip", ["-q", "report.zip", "timing-report.json"], { cwd: scratch, timeout: 5_000 });
    const result = await collectReport({ workflow_run: run }, "token", 9, reportTransport(readFileSync(join(scratch, "report.zip")), false, line(extra)));
    expect(result.issues).toEqual([]);
    expect(result.samples).toEqual([sample(), sample("http-stream-cancel", 260)]);
    expect(result.previousSamples).toEqual([sample(), sample("http-stream-cancel", 250)]);
    expect(JSON.stringify(result)).not.toContain("unrelated-top-level-sentinel");
    expect(JSON.stringify(result)).not.toContain("unrelated-environment-sentinel");
    expect(result.samples[0]).not.toBe(extra);
    expect(result.samples[0]?.environment).not.toBe(extra.environment);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the real Node entrypoint writes explicit missing-data evidence without accepting a fork event", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-timing-node-test-"));
  try {
    const event = join(scratch, "event.json");
    const summaryPath = join(scratch, "summary.md");
    writeFileSync(event, JSON.stringify({ workflow_run: { ...run, event: "pull_request" } }));
    const child = spawnSync("node", [new URL("./timing-report.ts", import.meta.url).pathname], {
      cwd: scratch, env: { ...process.env, GITHUB_TOKEN: "fixture-token-never-printed", GITHUB_EVENT_PATH: event, GITHUB_RUN_ID: "9", GITHUB_STEP_SUMMARY: summaryPath },
      encoding: "utf8", timeout: 10_000,
    });
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).not.toContain("fixture-token-never-printed");
    expect(JSON.parse(readFileSync(join(scratch, "timing-report.json"), "utf8"))).toMatchObject({ sourceSha: null, samples: [], issues: ["Timing collection failed; no complete current inventory is available"] });
    expect(readFileSync(summaryPath, "utf8")).toContain("missing");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("report workflow is hosted, read-only and limited to successful trusted main CI completion", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/timing-report.yml", import.meta.url), "utf8")) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: { report: { if: string; "runs-on": string; steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] } } };
  expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
  expect(workflow.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"], branches: ["main"] });
  expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  expect(workflow.jobs.report["runs-on"]).toBe("ubuntu-latest");
  expect(workflow.jobs.report.if).toContain("head_repository.full_name == github.repository");
  expect(workflow.jobs.report.if).toContain("workflow_run.event == 'push'");
  expect(workflow.jobs.report.if).toContain("workflow_run.conclusion == 'success'");
  expect(workflow.jobs.report.steps[0]?.with).toEqual({ ref: "${{ github.event.workflow_run.head_sha }}", "persist-credentials": false });
  expect(workflow.jobs.report.steps.filter(step => step.run).map(step => step.run)).toEqual(["node scripts/timing-report.ts"]);
});

test("timing sources and workflow select no unrelated native producer", () => {
  const paths = [".github/workflows/timing-report.yml", "scripts/timing-report.ts", "scripts/timing-observation.ts", "scripts/timing-report.test.ts", "checks/quality-timing-report.json", "web/tests/node-startup-diagnostic.test.ts", "web/tests/fake-timers-host.test.ts", "scripts/next-acceptance-http.test.ts"];
  expect(needsRust(paths)).toBe(false);
  expect(needsJsc(paths)).toBe(false);
  expect(needsSharedNative(paths)).toBe(false);
  expect(needsSharedSysroot(paths)).toBe(false);
});
