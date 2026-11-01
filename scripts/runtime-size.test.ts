import { expect, test } from "bun:test";
import { resolveRuntimePackage } from "./browser-build";
import { join } from "node:path";
import ts from "typescript-api";
import { initialJavaScript, checkCoreBudget, checkLazyProcessService, checkLazyInterruptRewriter, processServiceInputs, bunProcessAdapterInputs, moduleContributions } from "./runtime-size";

const runtime = resolveRuntimePackage(join(import.meta.dir, "../web/src/main.ts"));
const installed = (file: string) => join(runtime.path, file);

test("initial download closure deduplicates static chunks and omits lazy chunks and maps", () => {
  const outputs = {
    "dist/main.js": { imports: [{ path: "./chunks/shared.js", kind: "import-statement" }, { path: "./chunks/later.js", kind: "dynamic-import" }] },
    "dist/worker.js": { imports: [{ path: "./chunks/shared.js", kind: "import-statement" }] },
    "dist/chunks/shared.js": { imports: [{ path: "./leaf.js", kind: "import-statement" }] },
    "dist/chunks/leaf.js": { imports: [{ path: "./shared.js", kind: "import-statement" }] },
    "dist/chunks/later.js": { imports: [] },
    "dist/main.js.map": { imports: [] },
  };
  expect(initialJavaScript(outputs, ["dist/main.js", "dist/worker.js"])).toEqual([
    "dist/chunks/leaf.js", "dist/chunks/shared.js", "dist/main.js", "dist/worker.js",
  ]);
});

test("initial download accounting rejects missing chunks rather than silently undercounting", () => {
  expect(() => initialJavaScript({ "dist/main.js": { imports: [{ path: "./missing.js", kind: "import-statement" }] } }, ["dist/main.js"])).toThrow("missing.js");
});

test("initial download accounting refuses unmeasured static external scripts", () => {
  expect(() => initialJavaScript({ "main.js": { imports: [{ path: "https://example.test/large.js", kind: "import-statement", external: true }] } }, ["main.js"])).toThrow("Unmeasured external");
});

test("the first-spawn service gate allows reservation primitives but rejects service code", () => {
  const inputs = ["proc/stub.ts", "proc/identity.ts", "proc/intrinsics.ts", "proc/intrinsics/core.ts", "proc/intrinsics/host.ts", "proc/errors.ts", "proc/control.ts", "proc/directory.ts", "proc/outcome.ts", "proc/start-errno.ts", "proc/start-failure.ts", "proc/wait-status.ts", "proc/signals.ts", "proc/types.ts"].map(installed).concat(["web/src/bun-launcher.ts", "web/src/subprocess-broker.ts"]);
  expect(() => checkLazyProcessService(inputs, runtime)).not.toThrow();
  expect(processServiceInputs(inputs.concat([installed("proc/table.ts")]), runtime)).toEqual([installed("proc/table.ts")]);
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/supervisor.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/index.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/registry.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/intrinsics/future-service.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("proc/future-service.ts")]), runtime)).toThrow("process service is eager");
  expect(() => checkLazyProcessService(inputs.concat([installed("dist/proc/supervisor.js")]), runtime)).toThrow("process service is eager");
});

test("Bun policy attribution names current adapters without hiding generic service imports", () => {
  const adapters = ["web/src/bun-executor.ts", "/checkout/web/src/bun-launcher.ts", "web/src/subprocess-broker.ts"];
  const service = ["proc/abi.ts", "proc/worker-client.ts", "proc/worker-broker.ts", "proc/pipes.ts", "proc/worker-pipes.ts"].map(installed);
  const inputs = adapters.concat(service, ["web/src/worker.ts", "web/src/subprocess.ts", "web/src/worker-pipes.ts", "web/src/bun-executor.test.ts"]);
  expect(bunProcessAdapterInputs(inputs)).toEqual(adapters);
  expect(processServiceInputs(inputs, runtime)).toEqual(service);
  for (const file of service) expect(() => checkLazyProcessService([file], runtime)).toThrow("process service is eager");
});

test("realm-local terminal turn guards do not admit terminal or process services", () => {
  const guards = ["proc/terminal-turn.ts", "dist/proc/terminal-turn.js"].map(installed);
  expect(() => checkLazyProcessService(guards, runtime)).not.toThrow();
  const services = ["access", "pipes", "terminal-lifetime", "worker-client", "terminal-turn-service"]
    .flatMap(module => [`proc/${module}.ts`, `dist/proc/${module}.js`]).map(installed);
  for (const file of services) expect(() => checkLazyProcessService([file], runtime)).toThrow("process service is eager");
});

test("core gzip budget includes boundary, reports actionable excess", () => {
  expect(() => checkCoreBudget(10.8125 * 1024)).not.toThrow();
  expect(() => checkCoreBudget(10.8125 * 1024 + 1)).toThrow("core exceeds 11072 B gzip budget by 1 B");
});

test("Bun light initial downloads allow the tiny fatal check but never the binary rewriter", () => {
  const inputs = ["interrupt/check.ts", "proc/outcome.ts"].map(installed).concat(["web/src/bun-executor.ts"]);
  expect(() => checkLazyInterruptRewriter(inputs, runtime)).not.toThrow();
  for (const file of ["rewriter", "loader", "index", "future-compiler"]) {
    expect(() => checkLazyInterruptRewriter(inputs.concat([installed(`interrupt/${file}.ts`)]), runtime)).toThrow("interrupt rewriter is eager");
  }
  expect(() => checkLazyInterruptRewriter([installed("dist/interrupt/rewriter.js")], runtime)).toThrow("interrupt rewriter is eager");
});

test("lookalike proc and interrupt paths outside the installed package are not attributed", () => {
  const paths = ["/outside-the-package/runtime/proc/supervisor.ts", "/cache/other.runtime.git/proc/supervisor.ts", "/cache/other.runtime.git/interrupt/rewriter.ts"];
  expect(processServiceInputs(paths, runtime)).toEqual([]);
  expect(() => checkLazyInterruptRewriter(paths, runtime)).not.toThrow();
});

test("module attribution sums JS outputs, normalizes installed paths, and excludes maps", () => {
  const outputs = {
    "index.js": { inputs: { [installed("core/wasi.ts")]: { bytesInOutput: 100 }, "web/src/runner.ts": { bytesInOutput: 10 } } },
    "chunks/shared.js": { inputs: { [installed("core/wasi.ts")]: { bytesInOutput: 20 }, [installed("core/path.ts")]: { bytesInOutput: 5 } } },
    "index.js.map": { inputs: { [installed("core/wasi.ts")]: { bytesInOutput: 1000 } } },
  };
  expect(moduleContributions(outputs, runtime)).toEqual([
    { path: "core/wasi.ts", minified: 120 },
    { path: "web/src/runner.ts", minified: 10 },
    { path: "core/path.ts", minified: 5 },
  ]);
});


test("command definitions are an inert error type, not a process service", async () => {
  const source = await Bun.file(installed("proc/command.ts")).text();
  const parsed = ts.createSourceFile("command.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const values = parsed.statements.filter(node => !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node));
  expect(values).toHaveLength(1);
  const error = values[0];
  if (!error || !ts.isClassDeclaration(error)) throw new Error("Expected only the command error declaration");
  expect(error.name?.text).toBe("CommandStdioError");
  expect(error.modifiers?.map(modifier => modifier.kind)).toEqual([ts.SyntaxKind.ExportKeyword]);
  expect(error.heritageClauses?.map(clause => clause.getText(parsed))).toEqual(["extends Error"]);
  expect(error.members).toHaveLength(1);
  const constructor = error.members[0];
  if (!constructor || !ts.isConstructorDeclaration(constructor)) throw new Error("Command error must have no static blocks, methods or field initializers");
  expect(constructor.modifiers).toBeUndefined();
  expect(constructor.parameters.flatMap(parameter => Array.from(parameter.modifiers ?? [], modifier => modifier.kind))).toEqual([ts.SyntaxKind.ReadonlyKeyword]);
  expect(constructor.body?.getText(parsed).replace(/\s+/g, " ")).toBe('{ super(message); this.name = "CommandStdioError"; }');
  expect(new Bun.Transpiler({ loader: "ts" }).scan(source).imports).toEqual([]);
  expect(() => checkLazyProcessService([installed("proc/command.ts"), installed("dist/proc/command.js")], runtime)).not.toThrow();
  for (const service of ["command-runner", "command-stdio", "command-future"]) {
    expect(() => checkLazyProcessService([installed(`proc/${service}.ts`)], runtime)).toThrow("process service is eager");
  }
  expect(moduleContributions({ "main.js": { inputs: { [installed("proc/command.ts")]: { bytesInOutput: 98 } } } }, runtime)).toEqual([{ path: "proc/command.ts", minified: 98 }]);
});
