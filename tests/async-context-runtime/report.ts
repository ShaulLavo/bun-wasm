import assert from "node:assert/strict";

export type CodeOrigin = {
  id: string;
  kind: "file" | "new-async-function" | "eval" | "reused" | "constructor";
  source: string;
  sourceURL: string;
  constructor: string;
  compiledOnce: boolean;
};
type Observation = {
  caseName: string;
  request: string;
  phase: string;
  expected: string;
  actual: string | null;
  ok: boolean;
};
export type CaseReport = {
  name: string;
  origin: string;
  compiledOnce: boolean;
  requests: string[];
  error?: string;
};
export type Report = {
  version: 1;
  status: "pass" | "fail";
  origins: CodeOrigin[];
  cases: CaseReport[];
  observations: Observation[];
  failures: string[];
};

const requests = ["request-A", "request-B"];
const commonPhases = ["run.enter", "run.after-function", "run.timer", "run.catch", "run.finally", "nested.enter", "nested.timer", "nested.after-timer", "nested.exit"];
const dynamicPhases = ["dynamic.before-await", "dynamic.after-await", "dynamic.after-timer", "dynamic.catch", "dynamic.finally"];
const constructors = ["Function", "Function.prototype.constructor", "AsyncFunction", "AsyncFunction.prototype.constructor", "GeneratorFunction", "GeneratorFunction.prototype.constructor", "AsyncGeneratorFunction", "AsyncGeneratorFunction.prototype.constructor"];

function constructorPhases(name: string): string[] {
  if (name.startsWith("AsyncGeneratorFunction")) return ["constructor.async-generator-enter", "constructor.async-generator-after-await", "constructor.async-generator-after-timer"];
  if (name.startsWith("GeneratorFunction")) return ["constructor.generator-enter", "constructor.generator-resume"];
  if (name.startsWith("AsyncFunction")) return ["constructor.before-await", "constructor.after-await", "constructor.after-timer"];
  return ["constructor.sync"];
}

const expectedCases = [
  { name: "file-loaded", id: "file-loaded", kind: "file", constructor: "AsyncFunction", compiledOnce: false, phases: ["file.before-await", "file.after-await", "file.after-timer", "file.catch", "file.finally"] },
  { name: "new-async-function", id: "new-async-function", kind: "new-async-function", constructor: "AsyncFunction", compiledOnce: false, phases: dynamicPhases },
  { name: "eval", id: "eval", kind: "eval", constructor: "AsyncFunction", compiledOnce: false, phases: ["eval.before-await", "eval.after-await", "eval.after-timer", "eval.catch", "eval.finally"] },
  { name: "compiled-once-reused", id: "compiled-once-reused", kind: "reused", constructor: "AsyncFunction", compiledOnce: true, phases: dynamicPhases },
].concat(constructors.map(name => ({ name, id: `constructor-${name.replaceAll(".", "-")}`, kind: "constructor", constructor: name, compiledOnce: false, phases: constructorPhases(name) })));

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "report object required");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "report array required");
  return value;
}

function string(value: unknown): string {
  assert.equal(typeof value, "string", "report string required");
  assert.ok(typeof value === "string");
  return value;
}

function caseRow(value: unknown): string {
  const entry = object(value);
  assert.equal(entry.error, undefined, "case must complete without an error");
  return JSON.stringify([entry.name, entry.origin, entry.compiledOnce, entry.requests]);
}

function originRow(value: unknown): string {
  const entry = object(value);
  assert.ok(string(entry.source).length > 0, "origin source required");
  assert.ok(string(entry.sourceURL).length > 0, "origin source URL required");
  return JSON.stringify([entry.id, entry.kind, entry.constructor, entry.compiledOnce]);
}

function observation(value: unknown): Observation {
  const entry = object(value);
  assert.ok(typeof entry.actual === "string" || entry.actual === null, "observation actual store required");
  assert.ok(typeof entry.ok === "boolean", "observation success flag required");
  return {
    caseName: string(entry.caseName), request: string(entry.request), phase: string(entry.phase),
    expected: string(entry.expected), actual: entry.actual, ok: entry.ok,
  };
}

function observationKey(entry: Pick<Observation, "caseName" | "request" | "phase">): string {
  return `${entry.caseName}/${entry.request}/${entry.phase}`;
}

function expectedObservations(): Observation[] {
  return expectedCases.flatMap(entry => requests.flatMap(request => commonPhases.concat(entry.phases).map(phase => {
    const expected = phase.startsWith("nested.") && phase !== "nested.exit" ? `${request}:nested` : request;
    return { caseName: entry.name, request, phase, expected, actual: expected, ok: true };
  })));
}

function observationErrors(entries: unknown[]): string[] {
  const errors: string[] = [];
  const actual = new Map<string, Observation>();
  for (const value of entries) {
    const entry = observation(value);
    const key = observationKey(entry);
    if (actual.has(key)) errors.push(`${key}: duplicate observation`);
    actual.set(key, entry);
  }
  for (const expected of expectedObservations()) {
    const key = observationKey(expected);
    const entry = actual.get(key);
    if (!entry) errors.push(`${key}: missing observation`);
    if (entry && (entry.expected !== expected.expected || entry.actual !== expected.actual || !entry.ok)) errors.push(`${key}: expected ${expected.expected}, got ${entry.actual}`);
    actual.delete(key);
  }
  for (const key of actual.keys()) errors.push(`${key}: unexpected observation`);
  return errors;
}

export function evidenceFailures(value: unknown): string[] {
  try {
    const report = object(value);
    assert.equal(report.version, 1);
    const expectedCaseRows = expectedCases.map(entry => JSON.stringify([entry.name, entry.id, entry.compiledOnce, requests]));
    const actualCaseRows = array(report.cases).map(caseRow);
    assert.deepEqual(actualCaseRows.sort(), expectedCaseRows.sort(), "complete case and request set required");
    const expectedOriginRows = expectedCases.map(entry => JSON.stringify([entry.id, entry.kind, entry.constructor, entry.compiledOnce]));
    const actualOriginRows = array(report.origins).map(originRow);
    assert.deepEqual(actualOriginRows.sort(), expectedOriginRows.sort(), "complete origin set required");
    return observationErrors(array(report.observations));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function assertPassingReport(value: unknown, label: string): asserts value is Report {
  const report = object(value);
  assert.equal(report.status, "pass", `${label}: ${JSON.stringify(report.failures)}`);
  assert.deepEqual(report.failures, [], `${label}: no reported failures`);
  assert.deepEqual(evidenceFailures(report), [], `${label}: complete reference evidence required`);
}
