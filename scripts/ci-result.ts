function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing CI result object");
  return Object.fromEntries(Object.entries(value));
}

function selected(outputs: Record<string, unknown>, name: string): boolean {
  const value = outputs[name];
  if (value !== "true" && value !== "false") throw new Error(`Invalid CI selection: ${name}`);
  return value === "true";
}

function selectionFlags(value: unknown, event: string) {
  if (!["pull_request", "push", "workflow_dispatch"].includes(event)) throw new Error(`Invalid CI event: ${event}`);
  const results = object(value);
  const quality = object(results.quality);
  if (quality.result !== "success") throw new Error(`Source quality did not pass: ${String(quality.result)}`);
  const selection = object(results.selection);
  if (selection.result !== "success") throw new Error(`CI selection did not pass: ${String(selection.result)}`);
  const outputs = object(selection.outputs);
  const rust = selected(outputs, "rust");
  const browser = selected(outputs, "browser_guest");
  const jsc = selected(outputs, "jsc");
  if (rust && !browser) throw new Error("Native production must retain Browser consumers");
  if (jsc && !browser) throw new Error("JSC consumers require guest production");
  const native = rust || (event !== "pull_request" && browser);
  const sharedNative = selected(outputs, "shared-native");
  if (!rust && sharedNative) throw new Error("Native consumers require the native route");
  const shared = selected(outputs, "shared") || sharedNative;
  return { results, rust, browser, jsc, native, shared, sharedNative };
}

export function requireCiSuccess(value: unknown, event = "pull_request"): void {
  const { results, browser, native, shared, sharedNative } = selectionFlags(value, event);
  const expected = {
    selection: true,
    quality: true,
    "web-unit": true,
    "web-browser": true,
    "native-quality": native,
    "ordinary-build": browser,
    rust: native,
    "rust-fixtures": native,
    "shared-sysroot": shared,
    "browser-guest": browser,
    "shared-consumers": sharedNative,
  };
  for (const [name, required] of Object.entries(expected)) {
    const result = object(results[name]).result;
    const wanted = required ? "success" : "skipped";
    if (result !== wanted) throw new Error(`${name} must be ${wanted}, got ${String(result)}`);
  }
}

export function expectedBrowserGuestNames(matrixJson: string | undefined): string[] {
  if (!matrixJson) throw new Error("Missing BROWSER_GUEST_MATRIX");
  const parsed = object(JSON.parse(matrixJson));
  if (!Array.isArray(parsed.include) || parsed.include.length === 0) throw new Error("Empty browser-guest matrix");
  return parsed.include.map(entry => {
    const item = object(entry);
    if (typeof item.browser !== "string" || typeof item.batch !== "string" || !item.browser || !item.batch) {
      throw new Error("Invalid browser-guest matrix entry");
    }
    return `Browser guest (${item.browser}, ${item.batch})`;
  });
}

export const browserGuestJobPrefix = "Browser guest (";
export const sharedConsumerJobPrefix = "Shared native and Browser (";
export const expectedSharedConsumerNames = ["Shared native and Browser (quickjs-jsc)", "Shared native and Browser (spidermonkey)"] as const;

function verifyMatrixFamily(
  prefix: string,
  expectedNames: readonly string[],
  enabled: boolean,
  attemptJobs: readonly Record<string, unknown>[],
): void {
  const matched = attemptJobs.filter(job => typeof job.name === "string" && job.name.startsWith(prefix));
  if (!enabled) {
    const unexpected = matched.find(job => job.conclusion !== "skipped");
    if (unexpected) throw new Error(`Unexpected matrix job ${String(unexpected.name)}: ${String(unexpected.conclusion)}`);
    return;
  }
  const expectedSet = new Set(expectedNames);
  const extra = matched.find(job => !expectedSet.has(String(job.name)));
  if (extra) throw new Error(`Unexpected matrix job: ${String(extra.name)}`);
  const byName = new Map(matched.map(job => [String(job.name), job]));
  for (const name of expectedNames) {
    const job = byName.get(name);
    if (!job) throw new Error(`Missing matrix job: ${name}`);
    if (job.status !== "completed" || job.conclusion !== "success") {
      throw new Error(`Matrix job ${name} must be completed/success, got ${String(job.status)}/${String(job.conclusion)}`);
    }
  }
  if (matched.length !== expectedNames.length) throw new Error(`Duplicate matrix job under ${prefix}`);
}

export function verifyAttemptMatrixJobs(
  jobs: readonly unknown[],
  selection: { browser: boolean; sharedNative: boolean },
  browserMatrixJson?: string,
): void {
  const records = jobs.map(object);
  const browserNames = selection.browser ? expectedBrowserGuestNames(browserMatrixJson) : [];
  verifyMatrixFamily(browserGuestJobPrefix, browserNames, selection.browser, records);
  verifyMatrixFamily(sharedConsumerJobPrefix, expectedSharedConsumerNames, selection.sharedNative, records);
}

async function fetchAttemptJobs(repo: string, runId: string, attempt: string, token: string): Promise<unknown[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid GITHUB_REPOSITORY");
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error("Invalid GitHub run identity");
  let all: unknown[] = [];
  const signal = AbortSignal.timeout(20_000);
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal,
    });
    if (!response.ok) throw new Error(`Actions jobs API failed with HTTP ${response.status}`);
    const body = object(await response.json());
    if (!Array.isArray(body.jobs) || typeof body.total_count !== "number") throw new Error("Invalid Actions jobs response");
    all = all.concat(body.jobs);
    if (all.length >= body.total_count) return all;
    if (body.jobs.length !== 100) throw new Error("Incomplete Actions jobs page");
  }
  throw new Error("Actions jobs pagination limit exceeded");
}

if (import.meta.main) {
  const input = process.env.CI_RESULTS;
  if (!input) throw new Error("Missing CI_RESULTS");
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const parsed: unknown = JSON.parse(input);
  requireCiSuccess(parsed, event);
  const flags = selectionFlags(parsed, event);
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  const jobs = await fetchAttemptJobs(repo, runId, attempt, token);
  verifyAttemptMatrixJobs(jobs, { browser: flags.browser, sharedNative: flags.sharedNative }, process.env.BROWSER_GUEST_MATRIX);
  console.log("Every selected CI job and matrix leg passed");
}
