import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript-api";
import { processControls } from "./fixtures/process-controls";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-process-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const sourcePath = join(root, "crates/bunwasm-runtime/src/js/process.ts");
const output = join(scratch, "process.js");
const strip = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), sourcePath, output]);
assert.equal(strip.exitCode, 0, strip.stderr.toString());
const emitted = readFileSync(output, "utf8");

// Invert only the approved executable deltas. The pinned original AST hash guards the remainder.
function originalSyntax(text: string): string {
  const replacements: [RegExp, string, number][] = [
    [/\n  let execveWarned = false;\n/g, "\n", 1],
    [/\n    execve\(\) \{[\s\S]*?\n    \},/g, "", 1],
    [/const processBase\s*=/g, "const process =", 1],
    [/\bprocessBase\b/g, "process", 5],
    [/const streamBase\s*=/g, "const stream =", 2],
    [/\bstreamBase\b/g, "stream", 5],
    [/const stream\s*= Object\.assign/g, "Object.assign", 2],
    [/const process\s*= Object\.assign/g, "Object.assign", 1],
    [/function flushFailure\(pending\s*\)/g, "function flushFailure()", 1],
    [/const \{ error, callbacks \} = pending;/g, "const { error, callbacks } = failure;", 1],
    [/const pending\s*= (\{ error, callbacks:[^\n]+\});\n\s*failure = pending;/g, "failure = $1;", 1],
    [/internal\.nextTick\(\(\) => flushFailure\(pending\)\);/g, "internal.nextTick(flushFailure);", 1],
  ];
  for (const [pattern, replacement, count] of replacements) {
    assert.equal(Array.from(text.matchAll(pattern)).length, count, String(pattern));
    text = text.replace(pattern, replacement);
  }
  return text;
}
function syntax(text: string): string {
  const source = ts.createSourceFile("process.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(source);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(source)];
  }
  return JSON.stringify(visit(source));
}
const original = originalSyntax(emitted);

test("only approved staging and captured-failure changes affect the pinned process AST", () => {
  expect(createHash("sha256").update(syntax(original)).digest("hex")).toBe("392f346ac5d0efd2ad0b59a01bd8c8e34cb3e58a09f1d9fd2f53fbb4f37352d9");
  expect(emitted).toContain('"use strict";');
  expect(emitted).not.toContain("finally");
});

test("erasure preserves executable token positions, including exit operator bridges", () => {
  const typed = readFileSync(sourcePath, "utf8");
  const before = typed.split("\n");
  const after = emitted.split("\n");
  expect(after).toHaveLength(before.length);
  for (const [line, text] of after.entries()) {
    for (let column = 0; column < text.length; column++) {
      if (!/\s/.test(text[column]!)) expect(before[line]![column]).toBe(text[column]);
    }
  }
});

async function controls(source: string) {
  const context = createContext({ TextEncoder, TextDecoder, Uint8Array, Error, TypeError });
  const eventsSource = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.__eventsFactory = ${readFileSync(join(root, "crates/bunwasm-runtime/src/js/events.ts"), "utf8")}`);
  const events = runInContext(eventsSource, context);
  const factory = runInContext(source, context);
  return JSON.parse(JSON.stringify(await processControls(events, factory, assert)));
}

type ProcessSnapshot = Awaited<ReturnType<typeof processControls>>;

function setupSnapshot(source: string): ProcessSnapshot {
  const emitterCalls: string[][] = [];
  function EventEmitter(this: object) { emitterCalls.push(Reflect.ownKeys(this).map(String)); }
  const internal = {
    native: {
      platformInfo: { version: "test", revision: "test", arch: "wasm32" },
      env: () => ({}), argv: () => ["bun", "fixture.ts"], execPath: () => "/bin/bun",
      hostSignal(number: number, mode: number) { assert.deepEqual([number, mode], [13, 1]); return 0; },
    },
    nextTick() { throw new Error("setup must not schedule lifecycle work"); },
    require(name: string) {
      if (name === "events") return EventEmitter;
      if (name === "process_signals") return () => () => false;
      throw new Error("setup must not load " + name);
    },
  };
  const factory: unknown = runInContext(source, createContext({ Error, TypeError }));
  assert.ok(typeof factory === "function");
  const guest: unknown = Reflect.apply(factory, undefined, [internal]);
  assert.ok(guest !== null && typeof guest === "object");
  const keys = Reflect.ownKeys(guest);
  const descriptors = Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(guest, key)!;
    return [String(key), { enumerable: descriptor.enumerable, configurable: descriptor.configurable,
      writable: descriptor.writable, getter: typeof descriptor.get, setter: typeof descriptor.set, value: typeof descriptor.value }];
  }));
  assert.deepEqual(emitterCalls, [[]]);
  return { controls: [], shapes: { process: keys.map(String) }, coercions: [], descriptors, emitterCalls };
}

function expectProcessSnapshot(converted: ProcessSnapshot, baseline: ProcessSnapshot) {
  const keys = baseline.shapes.process!;
  expect(keys).not.toContain("execve");
  expect(Object.hasOwn(baseline.descriptors, "execve")).toBe(false);
  const kill = keys.indexOf("kill");
  expect(kill).toBeGreaterThan(0);
  expect(keys[kill - 1]).toBe("abort");
  const expectedKeys = keys.slice(0, kill).concat(["execve"], keys.slice(kill));
  const execve = { configurable: true, enumerable: true, writable: true,
    getter: "undefined", setter: "undefined", value: "function" } satisfies ProcessSnapshot["descriptors"][string];
  expect(converted.descriptors.execve).toEqual(execve);
  expect(converted.shapes.process).toEqual(expectedKeys);
  expect(converted).toEqual({
    ...baseline,
    shapes: { ...baseline.shapes, process: expectedKeys },
    descriptors: { ...baseline.descriptors, execve },
  });
}

test("isolated process setup preserves snapshots apart from the authorized execve shape", () => {
  expectProcessSnapshot(setupSnapshot(emitted), setupSnapshot(original));
});

const snapshotMutations: readonly [string, (snapshot: ProcessSnapshot) => void][] = [
  ["missing execve descriptor", snapshot => { delete snapshot.descriptors.execve; }],
  ["changed execve descriptor", snapshot => { snapshot.descriptors.execve!.enumerable = false; }],
  ["changed execve key order", snapshot => {
    const keys = snapshot.shapes.process!;
    const index = keys.indexOf("execve");
    keys.splice(index, 1);
    keys.splice(index + 1, 0, "execve");
  }],
  ["unapproved own key", snapshot => { snapshot.shapes.process!.push("unapproved"); }],
  ["unrelated descriptor", snapshot => { snapshot.descriptors.title!.writable = false; }],
  ["lifecycle result", snapshot => { snapshot.controls.push("unapproved"); }],
  ["coercion result", snapshot => { snapshot.coercions.push("unapproved"); }],
  ["emitter identity result", snapshot => { snapshot.emitterCalls.push([]); }],
];
for (const [name, mutate] of snapshotMutations) {
  test(`snapshot adaptation rejects ${name}`, () => {
    const baseline = setupSnapshot(original);
    const converted = setupSnapshot(emitted);
    mutate(converted);
    assert.throws(() => expectProcessSnapshot(converted, baseline));
  });
}

test("original and converted factories preserve lifecycle, identity, descriptors and coercions", async () => {
  expectProcessSnapshot(await controls(emitted), await controls(original));
});

const mutations: readonly [string, string, string][] = [
  ["callback snapshots lose reentrant appends", "for (const callback of callbacks)", "for (const callback of callbacks.slice())"],
  ["callback throws must prevent reset", "for (const callback of callbacks) callback(error);", "try { for (const callback of callbacks) callback(error); } finally { failure = null; stream.writable = true; }"],
  ["callbacks must not acquire a receiver", "callback(error);", "callback.call(stream, error);"],
  ["Symbol environment values stay raw", 'typeof key === "symbol" ? value : String(value)', "String(value)"],
];
for (const [name, before, after] of mutations) {
  test(`controls reject a semantic mutation: ${name}`, async () => {
    assert.ok(emitted.includes(before));
    await assert.rejects(() => controls(emitted.replace(before, after)));
  });
}

function contract(source: string) {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(probe, source);
  writeFileSync(config, JSON.stringify({ extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [], files: [
    join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), join(root, "crates/bunwasm-runtime/src/js/worker_protocol.d.ts"), probe,
  ] }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
}
test("accepts raw environment/hooks and the real process native shapes", () => {
  const result = contract(`declare const n: BunWasm.Native; declare const i: BunWasm.Internal;
const raw: unknown = n.env()[Symbol()]; i.workerEnvChange?.("accessor", raw);
const main: boolean = i.require("worker_threads").isMainThread;
n.writeStdout("x", true); n.writeStderr(new Uint8Array()); n.chdir("/");
const rss: number = n.memoryUsage().rss; const bytes: Uint8Array = n.readStdin();
i.require("process_signals")(i.require("events").prototype, new Map());`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
for (const call of ['const x: string = i.require("worker_threads").isMainThread', "n.writeStdout(1)", "n.chdir(false)", "n.isatty('fd')", "const s: string = n.env().RAW", "const x: string = n.memoryUsage().rss", "i.nextTick(7)", "i.workerEnvChange(7, 'x')"]) {
  test(`rejects false process contract: ${call}`, () => {
    const result = contract(`declare const n: BunWasm.Native; declare const i: BunWasm.Internal; ${call};`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toMatch(/error TS(?:2322|2345|2769)/);
  });
}


test("the factory retains the existing warning method for the unsupported execve path", () => {
  const result = contract(`declare const i: BunWasm.Internal;
const factory = ${readFileSync(sourcePath, "utf8")};
const guest = factory(i);
guest.emitWarning(new Error("source-only"));
guest.emitWarning("source-only", { type: Symbol("raw"), code: {} });
guest.emitWarning("source-only", "ExperimentalWarning", Symbol("raw"));`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("the factory keeps stored exitCode unknown rather than claiming a number", () => {
  const result = contract(`declare const i: BunWasm.Internal;
const factory = ${readFileSync(sourcePath, "utf8")};
const guest = factory(i);
const code: number = guest.exitCode;
guest.exitCode = Symbol("raw");`);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toContain("Type 'unknown' is not assignable to type 'number'");
});

for (const engine of ["bun", "node"]) {
  test(`${engine} pipe controls pin native differences without changing the guest fixture`, () => {
    const result = Bun.spawnSync([engine, new URL("./fixtures/process-native-controls.ts", import.meta.url).pathname], {
      stdin: Bun.file(join(root, "tests/fixtures/runtime-ts-process/stdin")), timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`PASS native pipe process controls ${engine}\n`);
  });
}
