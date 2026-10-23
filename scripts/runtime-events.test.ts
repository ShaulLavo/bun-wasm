import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-events-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const directory = join(root, "crates/bunwasm-runtime/src/js");
const source = readFileSync(join(directory, "events.ts"), "utf8");
const output = join(scratch, "events.js");
const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(directory, "events.ts"), output]);
if (result.exitCode !== 0) throw new Error(result.stderr.toString());
const emitted = readFileSync(output, "utf8");

function syntax(text: string) {
  const file = ts.createSourceFile("events.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(file);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(file)];
  }
  return JSON.stringify(visit(file));
}

test("events retains the actual PR140 JavaScript AST, literals and strict directive", () => {
  expect(createHash("sha256").update(syntax(emitted)).digest("hex"))
    .toBe("caad7b5dff757c58d789cb965da605c91206c9d6c384e52c89d8d10dc2eeb8ef");
});

test("emitted events retains publication rollback, once identity and strict receivers", () => {
  const changed: unknown[][] = [];
  const rejection = new Error("registration rejected");
  const factory = runInNewContext(emitted);
  const EventEmitter = factory({
    listenerChanged(target: object, type: string | symbol) {
      changed.push([target, type]);
      if (type === "reject") throw rejection;
    },
  });
  const emitter = new EventEmitter();
  function listener() {}
  expect(() => emitter.on("reject", listener)).toThrow(rejection);
  expect(emitter.listenerCount("reject")).toBe(0);
  expect(emitter.eventNames()).toEqual([]);
  emitter.prependOnceListener("value", listener);
  expect(emitter.rawListeners("value")[0].listener).toBe(listener);
  expect(emitter.listeners("value")).toEqual([listener]);
  emitter.emit("value");
  expect(emitter.listenerCount("value")).toBe(0);
  expect(changed.map(call => call[1])).toEqual(["reject", "value", "value"]);
  const emit = EventEmitter.prototype.emit;
  expect(() => emit("value")).toThrow();
});

function check(body: string) {
  const probe = join(scratch, "probe.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(probe, `const createEvents = ${source}\ndeclare const internal: BunWasm.Internal;\nconst EventEmitter = createEvents(internal);\nconst emitter = new EventEmitter();\n${body}\n`);
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
    files: [join(directory, "runtime.d.ts"), join(directory, "events-types.d.ts"), probe],
  }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
}

test("accepts emitter, once, iterator and precise internal dependency contracts", () => {
  const result = check(`
const key = Symbol("event");
const listener = function(this: unknown, ...args: unknown[]) { return args.length; };
emitter.on(key, listener).once(key, listener).prependOnceListener(key, listener).off(key, listener);
emitter.emit(key, 1, "two");
emitter.listenerCount(key, listener);
const values: Promise<unknown[]> = EventEmitter.once(emitter, key);
const iterator: BunWasm.Events.Iterator = EventEmitter.on(emitter, key, { close: ["done"] });
EventEmitter.once(new EventTarget(), "value");
EventEmitter.getEventListeners(new EventTarget(), "value");
EventEmitter.setMaxListeners(2, emitter);
internal.listenerChanged?.(emitter, key);
const description: string = internal.require("inspect").nodeInspect({ value: 1 });
const asyncEmitter = new (internal.require("event_emitter_async_resource"))({ name: "test", triggerAsyncId: 1 });
const id: number = asyncEmitter.asyncResource.asyncId();
`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalid: [string, string][] = [
  ["listener value", 'emitter.on("event", 7);'],
  ["prototype listener", 'EventEmitter.prototype.on("event", 7);'],
  ["event name", 'emitter.emit({}, 1);'],
  ["capture option", 'new EventEmitter({ captureRejections: "yes" });'],
  ["listener limit", 'emitter.setMaxListeners("ten");'],
  ["once signal", 'EventEmitter.once(emitter, "event", { signal: {} });'],
  ["iterator close name", 'EventEmitter.on(emitter, "event", { close: [false] });'],
  ["publication event", 'internal.listenerChanged?.(emitter, false);'],
  ["inspection result", 'const result: number = internal.require("inspect").nodeInspect(1);'],
  ["async resource options", 'new (internal.require("event_emitter_async_resource"))({ name: "test", triggerAsyncId: "one" });'],
  ["iterator payload", 'const value: Promise<string> = EventEmitter.on(emitter, "event").next();'],
];
for (const [label, body] of invalid) {
  test(`events rejects invalid ${label}`, () => {
    const result = check(body);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
