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

test("original and converted factories preserve lifecycle, identity, descriptors and coercions", async () => {
  async function controls(source: string) {
    const context = createContext({ TextEncoder, TextDecoder, Uint8Array, Error, TypeError });
    const events = runInContext(readFileSync(join(root, "crates/bunwasm-runtime/src/js/events.js"), "utf8"), context);
    const factory = runInContext(source, context);
    return JSON.parse(JSON.stringify(await processControls(events, factory, assert)));
  }
  expect(await controls(emitted)).toEqual(await controls(original));
});

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
n.writeStdout("x", true); n.writeStderr(new Uint8Array()); n.chdir("/");
const rss: number = n.memoryUsage().rss; const bytes: Uint8Array = n.readStdin();
i.require("process_signals")(i.require("events").prototype, new Map());`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
for (const call of ["n.writeStdout(1)", "n.chdir(false)", "n.isatty('fd')", "const s: string = n.env().RAW", "const x: string = n.memoryUsage().rss", "i.nextTick(7)"]) {
  test(`rejects false process contract: ${call}`, () => {
    expect(contract(`declare const n: BunWasm.Native; declare const i: BunWasm.Internal; ${call};`).exitCode).not.toBe(0);
  });
}
