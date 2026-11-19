import { test } from "bun:test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withBrowserGuestRegression, type BrowserGuestContext } from "./browser-guest-wrapper";
import { stageBrowserGuestInterruption } from "./browser-guest-coverage";
import { rowIdentity } from "./browser-guest-catalogue";
import { interruptionProofs, selectBundledInterruptionEngines, type InterruptionEngine } from "../web/tests/engine-interruption-cases";
import { assertEngineInterruptionResult } from "../web/tests/engine-interruption-result";

function browsers(leg: "chromium" | "webkit"): string[] { return leg === "chromium" ? ["chromium", "firefox"] : ["webkit"]; }

function selectedInterruptionEngines({ engines, artifact }: Pick<BrowserGuestContext, "engines" | "artifact">, env: NodeJS.ProcessEnv = process.env) {
  return selectBundledInterruptionEngines(engines, artifact.interruptionSpiderMonkey, env.BUN_WASM_INTERRUPTION_SPIDERMONKEY === "required");
}

function recordProofs(report: Record<string, unknown>, selected: readonly InterruptionEngine[], regression: BrowserGuestContext["regression"]): boolean {
  let error: string | undefined;
  try { assertEngineInterruptionResult(report, false, selected); }
  catch (failure) { error = String(failure); }
  for (const proof of interruptionProofs(selected)) regression.recordControl({ id: JSON.stringify([report.browser, proof.engine, proof.route, proof.name]), status: error ? "failed" : "passed", detail: error ?? "Exact selected named proof passed" });
  return error === undefined;
}

async function execute(context: BrowserGuestContext): Promise<void> {
  const { leg, artifact, regression, repository, directory, scratch, env, signal } = context;
  const selected = selectedInterruptionEngines(context, env);
  const dist = join(scratch, "interruption-guests");
  stageBrowserGuestInterruption(artifact, dist);
  const output = join(directory, "interruption.json");
  mkdirSync(join(scratch, "tmp"));
  const command: [string, ...string[]] = [process.execPath, join(repository, "web/tests/browser-engine-interruption.ts")];
  command.push(...browsers(leg).concat([`--engines=${selected.join(",")}`]));
  await regression.runChild({ signal, command, cwd: join(repository, "web"), rows: regression.expected,
  hangSeconds: 1400, env: { ...env, BUN_WASM_INTERRUPTION_DIST: dist, ENGINE_INTERRUPTION_BROWSER_BUNDLE: artifact.interruptionBundle,
    ENGINE_INTERRUPTION_OUTPUT: output, TMPDIR: join(scratch, "tmp") },
  evidence() {
    const value = JSON.parse(readFileSync(output, "utf8"));
    const reports = value.reports;
    if (!Array.isArray(reports) || JSON.stringify(reports.map(report => report.browser)) !== JSON.stringify(browsers(leg))) throw new Error("Missing/duplicate selected interruption browsers");
    const passed = new Set<string>();
    for (const report of reports) if (recordProofs(report, selected, regression)) passed.add(report.browser);
    return regression.expected.map(row => ({ id: rowIdentity(row), status: value.ok === true && passed.has(row.browser) ? "passed" : "failed", detail: "Selected default and handled SIGUSR1 plus all existing controls; see interruption.json" }));
  } });
}

test("selected browser engine interruption proofs", async () => {
  await withBrowserGuestRegression({ owner: "engine-interruption",
    controls: selection => browsers(selection.leg).flatMap(browser => interruptionProofs(selectedInterruptionEngines(selection))
      .map(proof => JSON.stringify([browser, proof.engine, proof.route, proof.name]))),
    execute,
  });
}, 3_120_000);
