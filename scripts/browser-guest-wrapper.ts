import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseBrowserGuestSelection, type CoverageEngine, type CoverageLeg, type CoverageOwner } from "./browser-guest-catalogue";
import { verifyBrowserGuestCoverage, type VerifiedBrowserGuestCoverage } from "./browser-guest-coverage";
import { BrowserGuestRegression, browserGuestLeg } from "./browser-guest-regression";

export interface BrowserGuestContext {
  readonly leg: CoverageLeg;
  readonly engines: readonly CoverageEngine[];
  readonly artifact: VerifiedBrowserGuestCoverage;
  readonly regression: BrowserGuestRegression;
  readonly repository: string;
  readonly directory: string;
  readonly scratch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
}
interface WrapperRequest {
  readonly owner: CoverageOwner;
  readonly controls: (selection: Pick<BrowserGuestContext, "leg" | "engines">) => readonly string[];
  readonly execute: (context: BrowserGuestContext) => Promise<void>;
}
const repository = resolve(import.meta.dir, "..");
const conflicts = new Set(["ROOT", "ENGINES", "ENGINE", "SLOTS", "PLAYWRIGHT", "HOST", "PORT", "ISOLATE", "LATENCY_MS", "PREVIEW_ORIGINS",
  "BUN_WASM_TEST_URL", "BUN_WASM_TEST_TMP", "BUN_WASM_TEST_PORT", "BUN_WASM_INTERRUPTION_DIST", "BUN_WASM_INTERRUPTION_BASELINE_DIST"]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}
function boundary(owner: CoverageOwner, env: NodeJS.ProcessEnv) {
  for (const name of Object.keys(env)) {
    if (env[name] === undefined) continue;
    if (conflicts.has(name) || /^(?:ENGINE_INTERRUPTION_|SAFARI_|BENCH_)/.test(name)) throw new Error(`Conflicting browser driver environment: ${name}`);
  }
  const selection = parseBrowserGuestSelection(JSON.parse(required(env, "BUN_WASM_BROWSER_COVERAGE_SELECTION")));
  const selected = selection.find(item => item.owner === owner);
  if (!selected) throw new Error(`Scheduled coverage owner is missing: ${owner}`);
  return { selected, leg: browserGuestLeg(env.BUN_WASM_TEST_BROWSERS),
    out: resolve(required(env, "BUN_WASM_BROWSER_SITE")), reports: resolve(required(env, "BUN_WASM_BROWSER_COVERAGE_REPORTS")) };
}

/** The only wrapper setup/teardown boundary; consumers supply their original driver adapter. */
export async function withBrowserGuestRegression(request: WrapperRequest, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { selected, leg, out, reports } = boundary(request.owner, env);
  const artifact = await verifyBrowserGuestCoverage({ out, selection: [selected] });
  mkdirSync(reports, { recursive: true });
  const directory = mkdtempSync(join(reports, `${request.owner}-${leg}-`));
  const regression = new BrowserGuestRegression({ owner: request.owner, leg, engines: selected.engines, directory,
    controls: request.controls({ leg, engines: selected.engines }), artifact });
  const controller = new AbortController(), stop = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  const failures: unknown[] = [];
  let scratch: string | undefined;
  try {
    // The finally path and signal handlers exist before private directories or children.
    scratch = mkdtempSync("/work/tmp/bun-wasm-bg-");
    writeFileSync(join(directory, "ownership.json"), JSON.stringify({ scratch, status: "owned" }) + "\n");
    await request.execute({ leg, engines: selected.engines, artifact, regression, repository, directory, scratch,
      signal: controller.signal, env: { ...env, ROOT: artifact.site, TMPDIR: scratch, TMP: scratch, TEMP: scratch, BUN_WASM_TEST_TMP: scratch } });
  } catch (error) { failures.push(error); }
  finally {
    try { regression.finish(); } catch (error) { failures.push(error); }
    teardown({ scratch, directory, regression, failures });
    for (const signal of signals) process.off(signal, stop);
  }
  if (failures.length) throw new AggregateError(failures, "Browser guest wrapper failed");
}

function teardown(request: { scratch: string | undefined; directory: string; regression: BrowserGuestRegression; failures: unknown[] }): void {
  const { scratch, directory, regression, failures } = request;
  if (!scratch) return;
  try {
    if (!regression.safeToReuse) {
      writeFileSync(join(directory, "ownership.json"), JSON.stringify({ scratch, status: "unsafe-retained" }) + "\n");
      throw new Error(`Unsafe child drain; retained private scratch: ${scratch}`);
    }
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(join(directory, "ownership.json"), JSON.stringify({ scratch, status: "removed" }) + "\n");
  } catch (error) { failures.push(error); }
}
