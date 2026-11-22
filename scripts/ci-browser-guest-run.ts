import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

type BatchEntry = { name: string; group?: string; jobSeconds: number; commandSeconds: number };
type RunResult = { label: string; batch: string; status: number; output: Buffer };

const root = resolve(import.meta.dir, "..");

function parseBatches(raw: string): BatchEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Missing BROWSER_GUEST_BATCHES");
  return parsed.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid browser guest batch entry");
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.jobSeconds !== "number" || typeof row.commandSeconds !== "number") {
      throw new Error("Malformed browser guest batch entry");
    }
    const group = typeof row.group === "string" ? row.group : row.name;
    return { name: row.name, group, jobSeconds: row.jobSeconds, commandSeconds: row.commandSeconds };
  });
}

function runCommand(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: number; output: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const suffix = signal ? [Buffer.from(`\n[terminated by ${signal}]\n`)] : [];
      resolvePromise({ status: code ?? 1, output: Buffer.concat(chunks.concat(suffix)) });
    });
  });
}

function computeDeadline(batch: BatchEntry, setupSeconds: number): number {
  const remaining = batch.jobSeconds - setupSeconds;
  return Math.min(remaining, batch.commandSeconds);
}

async function runBatch(batch: BatchEntry, browser: string, exact: boolean, setupSeconds: number, reportRoot: string, cwd: string): Promise<RunResult> {
  const deadline = computeDeadline(batch, setupSeconds);
  const label = exact ? `${browser}:${batch.name}` : batch.name;
  const reportSubdir = exact ? `${batch.name}-${browser}` : batch.name;
  const reports = join(reportRoot, reportSubdir);
  mkdirSync(reports, { recursive: true });
  if (deadline <= 0) {
    return { label, batch: batch.name, status: 124, output: Buffer.from(`Shared setup exhausted the ${batch.jobSeconds} second batch budget\n`) };
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_WASM_TEST_BROWSERS: browser,
    BUN_WASM_BROWSER_REPORT_DIR: reports,
    BUN_WASM_BROWSER_COVERAGE_REPORTS: reports,
    ...(exact ? { BUN_WASM_STORAGE_EXACT_BROWSERS: "1" } : {}),
  };
  const args = ["bun", join(root, "scripts/run-with-timeout.mts"), String(deadline), "bun", join(root, "scripts/test-checks.ts"), "browser-guest", "--batch", batch.name];
  const result = await runCommand(args, env, cwd);
  return { label, batch: batch.name, status: result.status, output: result.output };
}

async function runGroup(batches: readonly BatchEntry[], browser: string, setupSeconds: number, reportRoot: string, cwd: string): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const batch of batches) {
    if (batch.name === "10-storage" && browser === "chromium") {
      const parallel = await Promise.all([
        runBatch(batch, "chromium", true, setupSeconds, reportRoot, cwd),
        runBatch(batch, "firefox", true, setupSeconds, reportRoot, cwd),
      ]);
      results.push(...parallel);
      continue;
    }
    results.push(await runBatch(batch, browser, false, setupSeconds, reportRoot, cwd));
  }
  return results;
}

function reportResults(browser: string, results: readonly RunResult[], summaryPath?: string): number {
  if (summaryPath) {
    appendFileSync(summaryPath, `Browser guest (${browser})\n\nBatch | Exit status\n--- | ---\n`);
  }
  let failed = 0;
  for (const result of results) {
    process.stdout.write(`::group::Browser guest (${browser}, ${result.label})\n`);
    process.stdout.write(result.output);
    process.stdout.write("::endgroup::\n");
    if (summaryPath) appendFileSync(summaryPath, `${result.label} | ${result.status}\n`);
    if (result.status !== 0) {
      process.stdout.write(`::error title=Browser guest (${browser}, ${result.label})::Batch exited with status ${result.status}\n`);
      failed = 1;
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const browser = process.env.BUN_WASM_TEST_BROWSERS;
  const rawBatches = process.env.BROWSER_GUEST_BATCHES;
  const reportRoot = process.env.BUN_WASM_BROWSER_REPORT_DIR;
  const started = Number(process.env.BROWSER_GUEST_SETUP_STARTED ?? "0");
  if (!browser || !rawBatches || !reportRoot) throw new Error("Missing browser-guest runner environment");
  const setupSeconds = started > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - started) : 0;
  const batches = parseBatches(rawBatches);
  const grouped = Map.groupBy(batches, batch => batch.group ?? batch.name);
  const cwd = process.cwd();
  const groupOutputs = await Promise.all(
    Array.from(grouped.values(), group => runGroup(group, browser, setupSeconds, reportRoot, cwd)),
  );
  const results = groupOutputs.flat();
  process.exitCode = reportResults(browser, results, process.env.GITHUB_STEP_SUMMARY);
}

if (import.meta.main) await main();
