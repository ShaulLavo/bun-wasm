// Chrome check of a deployed sandbox: the iPhone smoke's three cells, run in Chrome for Testing with the
// goals-matrix Playwright transport against the live origin instead of a local asset server.
// Usage: bun scripts/chrome-live-smoke.ts --output=DIR [--base-url=https://bun.sprockt.dev/] [--timeout-ms=N]
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { frameworks, type Box, type Framework } from "./goals-matrix/catalog";
import { execute } from "./goals-matrix/execute";
import type { Cell, PhaseResult } from "./goals-matrix/model";
import { playgroundURL } from "./goals-matrix/run";
import { createPlaywrightTransport } from "./goals-matrix/transport";
import { smokeCases, smokePhases } from "./iphone-smoke/cases";
import { templateProfile } from "../web/src/playground/program-profile";

export interface LiveSmokeOptions {
  base: URL;
  output: string;
  timeoutMs: number;
  installTimeoutMs: number;
}
interface Deployment { sourceCommit: string; waffleVersion: string }
interface CellResult { box: Box; url: string; smokeGreen: boolean; summary: string; cell: Cell }

const usage = "Usage: bun scripts/chrome-live-smoke.ts --output=DIR [--base-url=URL] [--timeout-ms=N] [--install-timeout-ms=N]";

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer, not ${JSON.stringify(value)}`);
  return parsed;
}

export function liveSmokeOptions(argv: readonly string[]): LiveSmokeOptions {
  const { values } = parseArgs({
    args: argv.slice(), strict: true, allowPositionals: false,
    options: {
      "base-url": { type: "string", default: "https://bun.sprockt.dev/" },
      output: { type: "string" },
      "timeout-ms": { type: "string", default: "300000" },
      "install-timeout-ms": { type: "string", default: "600000" },
    },
  });
  if (!values.output) throw new Error(usage);
  const base = new URL(values["base-url"]);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error(`--base-url must be an http(s) URL: ${base.href}`);
  return {
    base, output: resolve(values.output),
    timeoutMs: positiveInteger(values["timeout-ms"], "timeout-ms"),
    installTimeoutMs: positiveInteger(values["install-timeout-ms"], "install-timeout-ms"),
  };
}

/** The iPhone smoke's cells, in Chrome. */
export function chromeCells(): Box[] {
  return smokeCases.map(box => ({ ...box, browser: "chrome" }));
}

/**
 * The deploy gate judges the iPhone smoke's phases, cleanup included. Later phases (hot reload, build,
 * preview) are recorded in the summary but never judged.
 */
export function smokeGreen(phases: readonly PhaseResult[]): boolean {
  return smokePhases.every(name => phases.some(result => result.phase === name && result.status === "pass"));
}

export function phaseSummary(phases: readonly PhaseResult[]): string {
  return phases.map(result => `${result.phase}:${result.status}`).join(" ");
}

export function overallStatus(results: readonly Pick<CellResult, "smokeGreen">[]): "green" | "red" {
  return results.length > 0 && results.every(result => result.smokeGreen) ? "green" : "red";
}

export function parseDeployment(value: unknown): Deployment {
  if (typeof value !== "object" || value === null) throw new Error("deployment.json is not an object");
  const { sourceCommit, waffleVersion } = value as Record<string, unknown>;
  if (typeof sourceCommit !== "string" || typeof waffleVersion !== "string") throw new Error("deployment.json lacks sourceCommit or waffleVersion");
  return { sourceCommit, waffleVersion };
}

async function fetchDeployment(base: URL): Promise<Deployment> {
  const response = await fetch(new URL("/deployment.json", base));
  if (!response.ok) throw new Error(`GET /deployment.json answered ${response.status}`);
  return parseDeployment(await response.json());
}

function frameworkFor(box: Box): Framework {
  const framework = frameworks.find(item => item.id === box.framework);
  if (!framework) throw new Error(`Unknown framework ${box.framework}`);
  return framework;
}

async function runCell(box: Box, options: LiveSmokeOptions): Promise<CellResult> {
  const framework = frameworkFor(box);
  const url = playgroundURL(new URL("/playground/", options.base).href, framework, box.engine);
  const name = `${box.framework}-${box.engine}`;
  const cell = await execute({
    box, framework, url, profile: templateProfile(box.engine, framework.template), port: 5173,
    timeoutMs: options.timeoutMs, installTimeoutMs: options.installTimeoutMs,
    createTransport: () => createPlaywrightTransport("chrome", options.timeoutMs, 10_000),
    saveLog: async text => { await writeFile(join(options.output, "logs", `${name}.log`), text); },
  });
  const phases = cell.attempts.at(-1)?.phases ?? [];
  const result = { box, url, smokeGreen: smokeGreen(phases), summary: phaseSummary(phases), cell };
  console.log(name, result.smokeGreen ? "smoke-pass" : "smoke-fail", result.summary);
  return result;
}

async function runLiveSmoke(options: LiveSmokeOptions): Promise<"green" | "red"> {
  await mkdir(join(options.output, "logs"), { recursive: true });
  const deployment = await fetchDeployment(options.base);
  const results: CellResult[] = [];
  // One cell at a time: each owns a whole browser and the shared preview port.
  for (const box of chromeCells()) results.push(await runCell(box, options));
  const status = overallStatus(results);
  await writeFile(join(options.output, "result.json"), JSON.stringify({ status, base: options.base.href, judgedPhases: smokePhases, deployment, results }, null, 2) + "\n");
  console.log(JSON.stringify({ status, sourceCommit: deployment.sourceCommit }));
  return status;
}

if (import.meta.main) {
  const status = await runLiveSmoke(liveSmokeOptions(process.argv.slice(2)));
  process.exit(status === "green" ? 0 : 1);
}
