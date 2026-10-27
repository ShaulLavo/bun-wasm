import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const js = "crates/bunwasm-runtime/src/js/";
const stdinGuard = "if (!stdin && !native.exists(path))";
const originalGuard = "if (!native.exists(path))";
const missingEntryDigest = "54de86a480dee49d3180c5390987a33122e52f559f4b11e70c75de93d0dd23e0";

function originalMissingGuard(text: string): string {
  assert.equal(text.split(stdinGuard).length, 2, "exactly one authorized stdin guard");
  return text.replace(stdinGuard, originalGuard);
}

function source(path: string): ts.SourceFile {
  const text = readFileSync(resolve(root, path), "utf8");
  return ts.createSourceFile(path, path === js + "bootstrap.js" ? originalMissingGuard(text) : text, ts.ScriptTarget.Latest, true);
}

function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}

function digest(node: ts.Node, file: ts.SourceFile): string {
  function syntax(value: ts.Node): unknown {
    const children = value.getChildren(file);
    return children.length ? [value.kind, children.map(syntax)] : [value.kind, value.getText(file)];
  }
  return createHash("sha256").update(JSON.stringify(syntax(node))).digest("hex");
}

// Only the authorized stdin guard is reversed before comparing the frozen PR128 syntax.
const contracts = [
  ["bootstrap.js", originalGuard, missingEntryDigest],
  ["builtins.js", '"node:trace_events":', "5caeb9e11d9cf86c20bd64a1ae96a45935f1af075b45f555608148b0dff89f26"],
  ["process.ts", "execve()", "3fd2f8decd0e15737125d817e3f7c80644b13b09da43e740ec1ebc19d61cb5c6"],
  ["process.ts", "execveWarned =", "76cb34635f1a5847bf8d957f8dd96445175fa217de83b93c18cbe04147a84e12"],
] as const;

for (const [path, prefix, expected] of contracts) {
  test(`residual syntax matches the accepted source: ${path} ${prefix}`, () => {
    const file = source(js + path);
    const node = find(file, value => value.getText(file).startsWith(prefix));
    expect(node).toBeDefined();
    if (!node) throw new Error(`Missing source contract: ${prefix}`);
    expect(digest(node, file)).toBe(expected);
  });
}

const bootstrap = readFileSync(resolve(root, js + "bootstrap.js"), "utf8");

function verifyMissingResidual(text: string): void {
  const file = ts.createSourceFile("bootstrap.js", originalMissingGuard(text), ts.ScriptTarget.Latest, true);
  const node = find(file, value => value.getText(file).startsWith(originalGuard));
  assert.ok(node, "accepted missing-entry branch exists");
  assert.equal(digest(node, file), missingEntryDigest);
}

function mainEntry(text: string, requested: string, mainArg: string, worker: boolean, exists = false) {
  const calls: string[] = [];
  const internal = {
    require: () => ({ resolve(path: string) { calls.push("resolve"); return path; } }),
    workerError: worker ? () => assert.fail("entry lookup must not invoke the worker hook") : undefined,
    runMain: (_requested: string): unknown => undefined,
  };
  const native = {
    mainArg: () => mainArg,
    exists() { calls.push("exists"); return exists; },
    moduleFormat: () => "esm",
    importModule(path: string) { calls.push("import"); return path; },
  };
  const start = text.indexOf("  internal.runMain =");
  const end = text.indexOf("  internal.getMainModule", start);
  assert.ok(start >= 0 && end > start, "production main-entry function");
  runInNewContext(text.slice(start, end), { internal, native, Error });
  return { run: () => internal.runMain(requested), calls };
}

function verifyMissingEntry(text: string, requested: string, mainArg: string, worker: boolean): void {
  const entry = mainEntry(text, requested, mainArg, worker);
  let thrown: unknown;
  try { entry.run(); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, "missing entry throws an Error");
  assert.equal(thrown.message, worker ? `Cannot find module '${requested}'` : `Module not found "${mainArg || requested}"`);
  assert.equal(Reflect.get(thrown, "code"), worker ? "MODULE_NOT_FOUND" : "ERR_MODULE_NOT_FOUND");
  assert.equal(Reflect.get(thrown, "__bunwasmPlain"), worker ? undefined : true);
  assert.deepEqual(entry.calls, ["resolve", "exists"]);
}

function verifyMainEntries(text: string): void {
  for (const [requested, mainArg] of [["/project/missing.ts", "missing.ts"], ["/project/missing.ts", ""], ["/project/missing.ts", "-"], ["/project/[stdin]", "./[stdin]"], ["/project/[stdin]", "--"]] satisfies [string, string][]) {
    verifyMissingEntry(text, requested, mainArg, false);
    verifyMissingEntry(text, requested, mainArg, true);
  }
  for (const worker of [false, true]) {
    const stdin = mainEntry(text, "/project/[stdin]", "-", worker);
    assert.equal(stdin.run(), "/project/[stdin]");
    assert.deepEqual(stdin.calls, ["import"]);
    const file = mainEntry(text, "/project/entry.ts", "entry.ts", worker, true);
    assert.equal(file.run(), "/project/entry.ts");
    assert.deepEqual(file.calls, ["resolve", "exists", "import"]);
  }
}

test("only the actual stdin sentinel bypasses lookup and the accepted missing main/worker errors", () => {
  verifyMainEntries(bootstrap);
});

for (const [label, before, after] of [
  ["broadened stdin exemption", 'requested.endsWith("/[stdin]") && native.mainArg() === "-"', 'requested.endsWith("/[stdin]") || native.mainArg() === "-"'],
  ["dash-prefixed stdin exemption", 'native.mainArg() === "-"', 'native.mainArg().startsWith("-")'],
  ["removed stdin existence exemption", stdinGuard, originalGuard],
  ["disabled worker error branch", "if (internal.workerError) throw", "if (false) throw"],
  ["changed worker error code", 'code: "MODULE_NOT_FOUND"', 'code: "ERR_MODULE_NOT_FOUND"'],
] satisfies [string, string, string][]) {
  test(`entry behavior rejects ${label}`, () => {
    const mutated = bootstrap.replace(before, after);
    expect(mutated).not.toBe(bootstrap);
    expect(() => verifyMainEntries(mutated)).toThrow();
  });
}

for (const [label, before, after] of [
  ["changed exemption guard", stdinGuard, "if (stdin || !native.exists(path))"],
  ["changed worker error branch", "if (internal.workerError) throw", "if (false) throw"],
] satisfies [string, string, string][]) {
  test(`the frozen missing-entry residual rejects ${label}`, () => {
    const mutated = bootstrap.replace(before, after);
    expect(mutated).not.toBe(bootstrap);
    expect(() => verifyMissingResidual(mutated)).toThrow();
  });
}

test("the Rust builtin table registers trace_events exactly once between tls and tty", () => {
  const text = readFileSync(resolve(root, "crates/bunwasm-runtime/src/resolve.rs"), "utf8");
  const table = text.match(/pub const NODE_BUILTINS: &\[&str\] = &\[([^\]]+)\];/)?.[1];
  expect(table).toBeDefined();
  const names = Array.from((table ?? "").matchAll(/"([^"]+)"/g), match => match[1]);
  expect(names.filter(name => name === "trace_events")).toHaveLength(1);
  expect(names.slice(names.indexOf("trace_events") - 1, names.indexOf("trace_events") + 2)).toEqual(["tls", "trace_events", "tty"]);
});
