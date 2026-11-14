import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { TIMING_PREFIX, timingWorkloads, type TimingSample } from "./timing-observation.ts";

const repository = "ShaulLavo/bun-wasm";
const api = `https://api.github.com/repos/${repository}`;
const metrics = Object.keys(timingWorkloads);
const jobs = ["Web host unit and types", "Web browser (20-preview)"];
const maxLogBytes = 8 * 1024 * 1024;
const maxJsonBytes = 512 * 1024;
const maxSamples = 8;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function textField(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32) return false;
  return true;
}

function environmentText(value: unknown): string {
  if (!textField(value)) throw new Error("Invalid timing environment");
  return value;
}

function parseEnvironment(value: unknown): TimingSample["environment"] {
  const environment = record(value);
  if (typeof environment.cores !== "number" || !Number.isSafeInteger(environment.cores) || environment.cores <= 0) throw new Error("Invalid CPU count");
  return {
    os: environmentText(environment.os), arch: environmentText(environment.arch),
    kernel: environmentText(environment.kernel), cpu: environmentText(environment.cpu), cores: environment.cores,
    runner: environmentText(environment.runner), image: environmentText(environment.image),
    imageVersion: environmentText(environment.imageVersion), runtime: environmentText(environment.runtime), browser: environmentText(environment.browser),
  };
}

export function parseSample(value: unknown): TimingSample {
  const row = record(value);
  if (row.schema !== 1 || row.outcome !== "pass" || !textField(row.metric) || !metrics.includes(row.metric)) throw new Error("Invalid timing schema, outcome or metric");
  const metric = row.metric as TimingSample["metric"];
  if (row.workload !== timingWorkloads[metric] || !textField(row.sourceSha) || !/^(?:[a-f0-9]{40}|local)$/.test(row.sourceSha)) throw new Error("Invalid timing workload or source");
  if (typeof row.elapsedMs !== "number" || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) throw new Error("Invalid elapsed observation");
  return {
    schema: 1, metric, workload: timingWorkloads[metric], sourceSha: row.sourceSha,
    elapsedMs: row.elapsedMs, outcome: "pass", environment: parseEnvironment(row.environment),
  };
}

async function* responseChunks(response: Response, limit: number): AsyncGenerator<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Response exceeds size limit"); }
  if (!response.body) return;
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("Response exceeds size limit");
      yield value;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of responseChunks(response, limit)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseLine(line: string, sha: string, samples: TimingSample[]): void {
  const start = line.indexOf(TIMING_PREFIX);
  if (start < 0) return;
  if (line.length > 16_384 || samples.length >= maxSamples) throw new Error("Timing row limit exceeded");
  const sample = parseSample(JSON.parse(line.slice(start + TIMING_PREFIX.length)));
  if (sample.sourceSha !== sha) throw new Error("Timing source differs from completed CI");
  samples.push(sample);
}

export async function parseTimingLog(response: Response, sha: string): Promise<TimingSample[]> {
  const samples: TimingSample[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of responseChunks(response, maxLogBytes)) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) parseLine(line, sha, samples);
    if (pending.length > 16_384) throw new Error("Log line exceeds size limit");
  }
  parseLine(pending + decoder.decode(), sha, samples);
  return samples;
}

export type Trend = { metric: string; status: "missing" | "first observation" | "incomparable" | "comparable"; currentMs: number | null; previousMs: number | null; changeMs: number | null };

function comparable(sample: TimingSample): boolean {
  return !Object.values(sample.environment).some(value => typeof value === "string" && /unknown|local/.test(value));
}

export function compareSamples(current: readonly TimingSample[], previous: readonly TimingSample[]): Trend[] {
  return metrics.map(metric => {
    const now = current.find(sample => sample.metric === metric);
    const before = previous.find(sample => sample.metric === metric);
    const base = { metric, currentMs: now?.elapsedMs ?? null, previousMs: before?.elapsedMs ?? null, changeMs: null };
    if (!now) return { ...base, status: "missing" };
    if (!before) return { ...base, status: "first observation" };
    const same = now.workload === before.workload && Object.entries(now.environment).every(([key, value]) => value === Reflect.get(before.environment, key));
    if (!same || !comparable(now) || !comparable(before)) return { ...base, status: "incomparable" };
    return { ...base, status: "comparable", changeMs: now.elapsedMs - before.elapsedMs };
  });
}

export function trustedRun(value: unknown): { id: number; run_attempt: number; head_sha: string } {
  const row = record(value);
  if (row.event !== "push" || row.head_branch !== "main" || row.status !== "completed" || row.conclusion !== "success"
    || record(row.head_repository).full_name !== repository || row.path !== ".github/workflows/ci.yml"
    || !Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !Number.isSafeInteger(row.run_attempt) || Number(row.run_attempt) <= 0
    || typeof row.head_sha !== "string" || !/^[a-f0-9]{40}$/.test(row.head_sha)) throw new Error("Timing requires successful same-repository main push CI");
  return { id: Number(row.id), run_attempt: Number(row.run_attempt), head_sha: row.head_sha };
}

export type Transport = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export async function githubRequest(url: string, token: string, consume: (response: Response) => Promise<Uint8Array>, transport: Transport = fetch, timeoutMs = 10_000): Promise<Uint8Array> {
  if (new URL(url).origin !== "https://api.github.com") throw new Error("Unexpected API origin");
  try { return await requestOnce(url, token, AbortSignal.timeout(timeoutMs), consume, transport); }
  catch { /* A second bounded GET also retries failures while reading the body. */ }
  try { return await requestOnce(url, token, AbortSignal.timeout(timeoutMs), consume, transport); }
  catch { throw new Error("GitHub timing request failed after two bounded attempts"); }
}

async function requestOnce(url: string, token: string, signal: AbortSignal, consume: (response: Response) => Promise<Uint8Array>, transport: Transport): Promise<Uint8Array> {
  let response = await transport(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || new URL(location).protocol !== "https:") throw new Error("Invalid download redirect");
    // Signed log and artifact URLs receive no API credentials, including on redirects.
    response = await transport(location, { redirect: "error", signal });
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error("GitHub response was unsuccessful"); }
  return consume(response);
}

class Github {
  private readonly token: string;
  private readonly transport: Transport;
  constructor(token: string, transport: Transport) { this.token = token; this.transport = transport; }
  bytes(path: string, limit: number): Promise<Uint8Array> {
    return githubRequest(api + path, this.token, response => readBounded(response, limit), this.transport);
  }
  async json(path: string): Promise<Record<string, unknown>> {
    return record(JSON.parse(new TextDecoder().decode(await this.bytes(path, maxJsonBytes))));
  }
  async samples(id: number, sha: string): Promise<TimingSample[]> {
    let samples: TimingSample[] = [];
    await githubRequest(`${api}/actions/jobs/${id}/logs`, this.token, async response => {
      samples = await parseTimingLog(response, sha);
      return new Uint8Array();
    }, this.transport);
    return samples;
  }
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected bounded API rows");
  return value.map(record);
}

function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid API identity");
  return Number(value);
}

async function currentSamples(client: Github, run: ReturnType<typeof trustedRun>, issues: string[]): Promise<TimingSample[]> {
  let all: Record<string, unknown>[] = [];
  // At most 300 job metadata rows, then two explicitly named small Web logs.
  for (let page = 1; page <= 3; page++) {
    const result = await client.json(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    all = all.concat(rows(result.jobs));
    if (all.length >= Number(result.total_count)) break;
    if (page === 3) throw new Error("Job inventory exceeds bounded selection");
  }
  const samples: TimingSample[] = [];
  for (const name of jobs) {
    const matches = all.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0]?.conclusion !== "success") { issues.push(`Missing successful job: ${name}`); continue; }
    try {
      const selected = await client.samples(positiveId(matches[0].id), run.head_sha);
      const expected = name === jobs[0] ? "diagnostic-controller-progress" : "http-stream-cancel";
      if (selected.length !== 1 || selected[0]?.metric !== expected) throw new Error("Missing or unexpected job metric");
      samples.push(...selected);
    }
    catch { issues.push(`Could not read valid bounded timing rows: ${name}`); }
  }
  if (samples.some((sample, index) => samples.findIndex(other => other.metric === sample.metric) !== index)) throw new Error("Duplicate timing metrics in CI logs");
  return samples;
}

async function previousSamples(client: Github, reportRun: number, issues: string[]): Promise<TimingSample[]> {
  const result = await client.json("/actions/workflows/timing-report.yml/runs?status=success&per_page=10");
  const previous = rows(result.workflow_runs).find(run => positiveId(run.id) < reportRun && run.event === "workflow_run" && run.head_branch === "main");
  if (!previous) { issues.push("No previous successful report in the last ten reports"); return []; }
  const artifacts = await client.json(`/actions/runs/${positiveId(previous.id)}/artifacts?per_page=10`);
  const artifact = rows(artifacts.artifacts).find(row => row.name === "ci-timing-report" && row.expired === false);
  if (!artifact) { issues.push("Previous report artifact is missing or expired"); return []; }
  if (typeof artifact.size_in_bytes !== "number" || artifact.size_in_bytes > 256 * 1024) throw new Error("Previous report artifact exceeds size limit");
  const archive = await client.bytes(`/actions/artifacts/${positiveId(artifact.id)}/zip`, 256 * 1024);
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-timing-report-"));
  try {
    const path = join(scratch, "report.zip");
    writeFileSync(path, archive);
    const json = execFileSync("unzip", ["-p", path, "timing-report.json"], { encoding: "utf8", maxBuffer: maxJsonBytes, timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
    const saved = record(JSON.parse(json));
    if (saved.schema !== 1 || !Array.isArray(saved.samples) || saved.samples.length > maxSamples) throw new Error("Invalid previous report");
    return saved.samples.map(parseSample);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function summary(trends: readonly Trend[], issues: readonly string[]): string {
  const table = trends.map(row => `| ${row.metric} | ${row.status} | ${row.currentMs ?? "missing"} | ${row.previousMs ?? "missing"} | ${row.changeMs ?? "n/a"} |`).join("\n");
  return `## Correctness timing observations\n\nReport only. These controlled fixtures are not product benchmarks. HTTP includes an intentional 250 ms stream delay; fake-timer and five-second stall cases are excluded. No speed threshold applies. Single samples include shared-runner noise.\n\n| Workload | Comparison | Current ms | Previous ms | Change ms |\n| --- | --- | ---: | ---: | ---: |\n${table}\n\n${issues.map(issue => `- ${issue}`).join("\n")}\n`;
}

export async function collectReport(event: unknown, token: string, reportRun: number, transport: Transport = fetch) {
  const issues: string[] = [];
  let samples: TimingSample[] = [], previous: TimingSample[] = [];
  let sourceSha: string | null = null;
  const client = new Github(token, transport);
  try {
    const run = trustedRun(record(event).workflow_run);
    const actual = trustedRun(await client.json(`/actions/runs/${run.id}`));
    if (JSON.stringify(actual) !== JSON.stringify(run)) throw new Error("Completed CI identity changed");
    sourceSha = run.head_sha;
    samples = await currentSamples(client, run, issues);
    try { previous = await previousSamples(client, positiveId(reportRun), issues); }
    catch { issues.push("Previous report could not be read within download and schema bounds"); }
  } catch { issues.push("Timing collection failed; no complete current inventory is available"); }
  const trends = compareSamples(samples, previous);
  return { schema: 1, sourceSha, samples, previousSamples: previous, trends, issues };
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !eventPath) throw new Error("Missing timing reporter environment");
  const report = await collectReport(JSON.parse(readFileSync(eventPath, "utf8")), token, Number(process.env.GITHUB_RUN_ID));
  writeFileSync("timing-report.json", JSON.stringify(report, null, 2) + "\n");
  const markdown = summary(report.trends, report.issues);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  if (report.issues.length || report.trends.some(row => row.status === "missing")) console.log("::warning::Timing report has missing data or collection diagnostics; inspect the summary");
  if (report.trends.some(row => row.status === "missing")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("::error::Timing report failed; no credentials or download URLs logged"); process.exitCode = 1; });
}
