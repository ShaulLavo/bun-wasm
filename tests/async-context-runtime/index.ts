import { AsyncLocalStorage } from "node:async_hooks";
import { loadedFromFile, type Note } from "./loaded.ts";
import { evidenceFailures, type CaseReport, type CodeOrigin, type Report } from "./report.ts";

type Store = { request: string; nested?: string };
type AsyncCase = (note: Note, timer: (phase: string) => Promise<void>) => unknown;

const storage = new AsyncLocalStorage<Store>();
const origins: CodeOrigin[] = [];
const cases: CaseReport[] = [];
const observations: Report["observations"] = [];
const failures: string[] = [];

function addOrigin(origin: CodeOrigin): void {
  origins.push(origin);
}

function currentStore(): Store | undefined {
  return storage.getStore();
}

function record(caseName: string, request: string, phase: string, expected: string): void {
  const store = currentStore();
  const actual = store ? store.nested ?? store.request : null;
  const ok = actual === expected;
  observations.push({ caseName, request, phase, expected, actual, ok });
  if (ok) return;
  failures.push(`${caseName}/${request}/${phase}: expected ${expected}, got ${actual ?? "undefined"}`);
}

function timer(caseName: string, request: string, expected = request): (phase: string) => Promise<void> {
  return phase => new Promise(resolve => {
    setTimeout(() => {
      record(caseName, request, phase, expected);
      resolve();
    }, 0);
  });
}

function makeNote(caseName: string, request: string): Note {
  return (phase, expected = request) => record(caseName, request, phase, expected);
}

async function runNested(name: string, request: string): Promise<void> {
  const expected = `${request}:nested`;
  const note = makeNote(name, request);
  const wait = timer(name, request, expected);
  await storage.run({ request, nested: expected }, async () => {
    note("nested.enter", expected);
    await wait("nested.timer");
    note("nested.after-timer", expected);
  });
}

async function requestBody(name: string, request: string, fn: AsyncCase): Promise<void> {
  const note = makeNote(name, request);
  const wait = timer(name, request);
  note("run.enter");
  await fn(note, wait);
  note("run.after-function");
  await wait("run.timer");
  const rejection = new Error("outer rejection");
  try {
    await Promise.reject(rejection);
    throw new Error("outer expected rejection fulfilled");
  } catch (caught) {
    if (caught !== rejection) throw caught;
    note("run.catch");
  } finally {
    note("run.finally");
  }
  await runNested(name, request);
  note("nested.exit");
}

async function runCase(name: string, origin: CodeOrigin, fn: AsyncCase): Promise<void> {
  const requests = ["request-A", "request-B"];
  const report: CaseReport = { name, origin: origin.id, compiledOnce: origin.compiledOnce, requests };
  cases.push(report);
  const runRequest = (request: string) => storage.run({ request }, () => requestBody(name, request, fn));
  try {
    await Promise.all(requests.map(runRequest));
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    report.error = message;
    failures.push(`${name}: ${message}`);
  }
}

function sourceURL(id: string): string {
  return `ctx01-${id}.js`;
}

function asyncFunctionConstructor(): FunctionConstructor {
  return Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
}

function generatorFunctionConstructor(): FunctionConstructor {
  return Object.getPrototypeOf(function* () {}).constructor as FunctionConstructor;
}

function asyncGeneratorFunctionConstructor(): FunctionConstructor {
  return Object.getPrototypeOf(async function* () {}).constructor as FunctionConstructor;
}

function makeDynamicAsync(ctor: FunctionConstructor, id: string, kind: CodeOrigin["kind"]): AsyncCase {
  const fn = new ctor(
    "note",
    "timer",
    `note("dynamic.before-await"); await Promise.resolve(); note("dynamic.after-await"); await timer("dynamic.after-timer"); const rejection = new Error("dynamic rejection"); try { await Promise.reject(rejection); throw new Error("dynamic expected rejection fulfilled"); } catch (caught) { if (caught !== rejection) throw caught; note("dynamic.catch"); } finally { note("dynamic.finally"); }\n//# sourceURL=${sourceURL(id)}`,
  ) as AsyncCase;
  addOrigin({ id, kind, source: Function.prototype.toString.call(fn), sourceURL: sourceURL(id), constructor: ctor.name, compiledOnce: kind === "reused" });
  return fn;
}

function makeEvaluated(): AsyncCase {
  const source = `(async function evaluated(note, timer) { note("eval.before-await"); await Promise.resolve(); note("eval.after-await"); await timer("eval.after-timer"); const rejection = new Error("eval rejection"); try { await Promise.reject(rejection); throw new Error("eval expected rejection fulfilled"); } catch (caught) { if (caught !== rejection) throw caught; note("eval.catch"); } finally { note("eval.finally"); } })\n//# sourceURL=${sourceURL("eval")}`;
  // oxlint-disable-next-line no-eval -- Direct eval is the behavior under test.
  const fn = eval(source) as AsyncCase;
  addOrigin({ id: "eval", kind: "eval", source, sourceURL: sourceURL("eval"), constructor: "AsyncFunction", compiledOnce: false });
  return fn;
}

type ConstructorMode = "function" | "async" | "generator" | "async-generator";

async function invokeConstructor(mode: ConstructorMode, fn: unknown, note: Note, wait: (phase: string) => Promise<void>): Promise<void> {
  if (mode === "function") {
    (fn as (note: Note) => void)(note);
    return;
  }
  if (mode === "async") {
    await (fn as AsyncCase)(note, wait);
    return;
  }
  if (mode === "generator") {
    for (const value of (fn as (note: Note) => Iterable<unknown>)(note)) await value;
    return;
  }
  for await (const value of (fn as (note: Note, wait: (phase: string) => Promise<void>) => AsyncGenerator<unknown>)(note, wait)) void value;
}

async function runConstructors(): Promise<void> {
  const constructors = [
    { name: "Function", ctor: Function, mode: "function" },
    { name: "Function.prototype.constructor", ctor: Function.prototype.constructor, mode: "function" },
    { name: "AsyncFunction", ctor: asyncFunctionConstructor(), mode: "async" },
    { name: "AsyncFunction.prototype.constructor", ctor: asyncFunctionConstructor().prototype.constructor, mode: "async" },
    { name: "GeneratorFunction", ctor: generatorFunctionConstructor(), mode: "generator" },
    { name: "GeneratorFunction.prototype.constructor", ctor: generatorFunctionConstructor().prototype.constructor, mode: "generator" },
    { name: "AsyncGeneratorFunction", ctor: asyncGeneratorFunctionConstructor(), mode: "async-generator" },
    { name: "AsyncGeneratorFunction.prototype.constructor", ctor: asyncGeneratorFunctionConstructor().prototype.constructor, mode: "async-generator" },
  ] as const;
  for (const entry of constructors) {
    const id = `constructor-${entry.name.replaceAll(".", "-")}`;
    const sourceURLValue = sourceURL(id);
    let fn: unknown;
    if (entry.mode === "function") {
      fn = entry.ctor("note", `note("constructor.sync");\n//# sourceURL=${sourceURLValue}`);
    } else if (entry.mode === "async") {
      fn = entry.ctor("note", "timer", `note("constructor.before-await"); await Promise.resolve(); note("constructor.after-await"); await timer("constructor.after-timer");\n//# sourceURL=${sourceURLValue}`);
    } else if (entry.mode === "generator") {
      fn = entry.ctor("note", `note("constructor.generator-enter"); yield Promise.resolve(); note("constructor.generator-resume");\n//# sourceURL=${sourceURLValue}`);
    } else {
      fn = entry.ctor("note", "timer", `note("constructor.async-generator-enter"); await Promise.resolve(); note("constructor.async-generator-after-await"); await timer("constructor.async-generator-after-timer"); yield 1;\n//# sourceURL=${sourceURLValue}`);
    }
    addOrigin({ id, kind: "constructor", source: Function.prototype.toString.call(fn), sourceURL: sourceURLValue, constructor: entry.name, compiledOnce: false });
    const invoke: AsyncCase = (note, wait) => invokeConstructor(entry.mode, fn, note, wait);
    await runCase(entry.name, { id, kind: "constructor", source: Function.prototype.toString.call(fn), sourceURL: sourceURLValue, constructor: entry.name, compiledOnce: false }, invoke);
  }
}

async function main(): Promise<Report> {
  const fileOrigin: CodeOrigin = {
    id: "file-loaded",
    kind: "file",
    source: "tests/async-context-runtime/loaded.ts",
    sourceURL: "file:///tests/async-context-runtime/loaded.ts",
    constructor: "AsyncFunction",
    compiledOnce: false,
  };
  addOrigin(fileOrigin);
  await runCase("file-loaded", fileOrigin, (note, wait) => loadedFromFile(note, wait));

  const asyncConstructor = asyncFunctionConstructor();
  const dynamic = makeDynamicAsync(asyncConstructor, "new-async-function", "new-async-function");
  await runCase("new-async-function", origins.at(-1)!, dynamic);

  const evaluated = makeEvaluated();
  await runCase("eval", origins.at(-1)!, evaluated);

  const reused = makeDynamicAsync(asyncConstructor, "compiled-once-reused", "reused");
  await runCase("compiled-once-reused", origins.at(-1)!, reused);

  await runConstructors();
  const report: Report = { version: 1, status: "pass", origins, cases, observations, failures };
  failures.push(...evidenceFailures(report));
  report.status = failures.length === 0 ? "pass" : "fail";
  return report;
}

const report = await main();
console.log(`CTX01_RESULT ${JSON.stringify(report)}`);
process.exitCode = report.status === "pass" ? 0 : 1;
