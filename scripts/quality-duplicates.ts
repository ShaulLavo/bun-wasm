import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fingerprintPattern = /^[0-9a-f]{16}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const nativeArguments = [
  "--config",
  ".jscpd.json",
  "--baseline",
  ".jscpd-baseline.json",
  "--fail-on-new-clones",
  "0",
  "--fail-on-empty",
];

type JsonObject = { readonly [key: string]: unknown };

export interface DuplicateBaseline {
  readonly version: 1;
  readonly fingerprints: Readonly<Record<string, number>>;
  readonly reasons: Readonly<Record<string, string>>;
}

export type ComparisonBaseline = {
  readonly version: 1;
  readonly fingerprints: Readonly<Record<string, number>>;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFingerprintMap(value: unknown, label: string): Record<string, number> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const fingerprints: Record<string, number> = {};
  for (const [fingerprint, count] of Object.entries(value)) {
    if (!fingerprintPattern.test(fingerprint))
      throw new Error(`${label} has malformed fingerprint: ${fingerprint}`);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
      throw new Error(`${label} count for ${fingerprint} must be a positive safe integer`);
    fingerprints[fingerprint] = count;
  }
  return fingerprints;
}

function parseVersionAndFingerprints(value: unknown, label: string): Record<string, number> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (value.version !== 1) throw new Error(`${label} version must be 1`);
  return parseFingerprintMap(value.fingerprints, `${label}.fingerprints`);
}

function parseReasons(value: unknown, fingerprints: Readonly<Record<string, number>>): Record<string, string> {
  if (!isObject(value)) throw new Error("baseline.reasons must be an object");
  const reasons: Record<string, string> = {};
  for (const [fingerprint, reason] of Object.entries(value)) {
    if (!Object.hasOwn(fingerprints, fingerprint))
      throw new Error(`baseline.reasons has orphan fingerprint: ${fingerprint}`);
    if (typeof reason !== "string" || reason.length === 0 || reason !== reason.trim())
      throw new Error(`baseline reason for ${fingerprint} must be a trimmed, nonempty string`);
    if (/[\r\n\u2028\u2029]/.test(reason)) throw new Error(`baseline reason for ${fingerprint} must be single-line`);
    reasons[fingerprint] = reason;
  }
  for (const fingerprint of Object.keys(fingerprints)) {
    if (!Object.hasOwn(reasons, fingerprint))
      throw new Error(`baseline is missing a reason for ${fingerprint}`);
  }
  return reasons;
}

export function parseBaseline(value: unknown, label = "baseline"): DuplicateBaseline {
  const fingerprints = parseVersionAndFingerprints(value, label);
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const reasons = parseReasons(value.reasons, fingerprints);
  return { version: 1, fingerprints, reasons };
}

export function parseComparisonBaseline(value: unknown, label = "comparison baseline"): ComparisonBaseline {
  return { version: 1, fingerprints: parseVersionAndFingerprints(value, label) };
}

export function compareAllowances(
  current: Readonly<Record<string, number>>,
  base: Readonly<Record<string, number>>,
): void {
  for (const [fingerprint, count] of Object.entries(current)) {
    const baseCount = base[fingerprint];
    if (baseCount === undefined)
      throw new Error(`duplicate baseline adds allowance ${fingerprint}`);
    if (count > baseCount)
      throw new Error(`duplicate baseline increases allowance ${fingerprint}: ${baseCount} -> ${count}`);
  }
}

export function buildJscpdArgs(forwarded: readonly string[]): string[] {
  if (forwarded.length !== 0 && !(forwarded.length === 2 && forwarded[0] === "--kind" && forwarded[1] === "ast"))
    throw new Error("Usage: quality:duplicates [--kind ast]");
  return nativeArguments.concat(forwarded);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requireCommit(cwd: string, value: string, name: string): string {
  if (!commitPattern.test(value)) throw new Error(`${name} must be a full commit ID: ${value}`);
  try {
    const resolved = git(cwd, ["rev-parse", "--verify", `${value}^{commit}`]);
    if (resolved !== value) throw new Error(`${name} does not resolve to itself: ${value} -> ${resolved}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not resolve to itself")) throw error;
    throw new Error(`Missing commit object for ${name}: ${value}`);
  }
  return value;
}

export function resolveBaseRef(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.JSCPD_BASE_REF !== undefined) {
    if (env.JSCPD_BASE_REF.length === 0) throw new Error("Missing JSCPD_BASE_REF");
    return requireCommit(cwd, env.JSCPD_BASE_REF, "JSCPD_BASE_REF");
  }
  let mergeBase: string;
  try {
    mergeBase = git(cwd, ["merge-base", "HEAD", "origin/main"]);
  } catch {
    throw new Error("Unable to resolve local duplicate baseline merge base with origin/main");
  }
  return requireCommit(cwd, mergeBase, "local duplicate baseline merge base");
}

function readComparisonBaseline(cwd: string, ref: string): ComparisonBaseline {
  let source: string;
  try {
    source = execFileSync("git", ["show", `${ref}:.jscpd-baseline.json`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`Unable to read .jscpd-baseline.json from comparison commit ${ref}`);
  }
  try {
    return parseComparisonBaseline(JSON.parse(source), `comparison baseline at ${ref}`);
  } catch (error) {
    throw new Error(`Invalid .jscpd-baseline.json at comparison commit ${ref}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const cwd = process.cwd();
  const baselinePath = join(cwd, ".jscpd-baseline.json");
  const current = parseBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
  const baseRef = resolveBaseRef(cwd);
  const comparison = readComparisonBaseline(cwd, baseRef);
  compareAllowances(current.fingerprints, comparison.fingerprints);
  const result = spawnSync("jscpd", buildJscpdArgs(process.argv.slice(2)), {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`jscpd terminated by ${result.signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
