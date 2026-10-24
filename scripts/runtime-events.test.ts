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

test("events pins audited executable changes and the unchanged PR140 remainder", () => {
  expect(createHash("sha256").update(syntax(emitted)).digest("hex")).toBe("ca337cb233afa9eb32c362403ebae92701ebc59d4667722de6c007ce950bfcb0");
  const file = ts.createSourceFile("events.js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const changed = new Set([
    "addListener", "onceWrapper", "onceWrap", "proto.emit", "proto.removeAllListeners",
    "EventEmitter.on", "EventEmitter.addAbortListener",
  ]);
  const remainder: string[] = [];
  function collect(node: ts.Node) {
    if (!ts.isFunctionExpression(node) || node.parameters[0]?.name.getText(file) !== "internal") {
      ts.forEachChild(node, collect);
      return;
    }
    for (const statement of node.body.statements) {
      const text = statement.getText(file);
      if (ts.isFunctionDeclaration(statement) && changed.has(statement.name?.text ?? "")) continue;
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && changed.has(statement.expression.left.getText(file))) continue;
      if (text.startsWith("const proto") || text.startsWith("EventEmitter.prototype._eventsCount")
        || text.startsWith("proto._eventsCount")
        || text.startsWith('Object.defineProperty(proto.removeAllListeners, "length"')) continue;
      remainder.push(syntax(text));
    }
  }
  collect(file);
  expect(remainder.length).toBe(59);
  expect(createHash("sha256").update(JSON.stringify(remainder)).digest("hex")).toBe("37ebfa24afb35f69f25af1c8248a86299d6ba62d1dd346d8daf4085cf5e0541a");
});

test("events has exactly the approved constructor bridge and no other assertion escape", () => {
  const file = ts.createSourceFile("events.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const escapes: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || node.kind === ts.SyntaxKind.AnyKeyword) escapes.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(escapes).toEqual(["EventEmitter as typeof EventEmitter & BunWasm.Events.Constructor"]);
  expect(source).not.toMatch(/@ts-(?:ignore|expect-error|nocheck)/);
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
  expect(EventEmitter.prototype._events).toBeUndefined();
  expect(() => EventEmitter.prototype._events["never"]).toThrow();
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

test("constructor bridge matches actual call, construction, prototype and installed static descriptors", () => {
  const required: string[] = [];
  function AsyncResource() {}
  const EventEmitter = runInNewContext(emitted)({
    require(name: string) { required.push(name); return AsyncResource; },
  });
  expect(required).toEqual([]);
  expect(Object.getOwnPropertyDescriptor(EventEmitter, "prototype")).toEqual({
    value: EventEmitter.prototype, writable: true, enumerable: false, configurable: false,
  });
  expect(Object.getOwnPropertyDescriptor(EventEmitter.prototype, "constructor")).toEqual({
    value: EventEmitter, writable: true, enumerable: false, configurable: true,
  });
  expect(EventEmitter.EventEmitter).toBe(EventEmitter);
  expect(EventEmitter.usingDomains).toBe(false);
  expect(EventEmitter.name).toBe("EventEmitter");
  expect(EventEmitter.length).toBe(1);
  expect(Reflect.ownKeys(EventEmitter)).toEqual([
    "length", "name", "prototype", "init", "EventEmitter", "usingDomains", "captureRejectionSymbol",
    "errorMonitor", "kMaxEventTargetListeners", "kMaxEventTargetListenersWarned", "defaultMaxListeners",
    "captureRejections", "listenerCount", "getEventListeners", "getMaxListeners", "setMaxListeners",
    "once", "on", "addAbortListener", "EventEmitterAsyncResource",
  ]);
  for (const name of ["defaultMaxListeners", "captureRejections", "EventEmitterAsyncResource"]) {
    const descriptor = Object.getOwnPropertyDescriptor(EventEmitter, name);
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.configurable).toBe(name === "EventEmitterAsyncResource");
    expect(typeof descriptor?.get).toBe("function");
    expect(typeof descriptor?.set).toBe(name === "EventEmitterAsyncResource" ? "undefined" : "function");
  }
  expect(EventEmitter.EventEmitterAsyncResource).toBe(AsyncResource);
  expect(required).toEqual(["event_emitter_async_resource"]);
  const receiver = {};
  expect(EventEmitter.call(receiver)).toBeUndefined();
  expect(Object.getPrototypeOf(Reflect.get(receiver, "_events"))).toBeNull();
  expect(Reflect.get(receiver, "_eventsCount")).toBe(0);
  expect(() => Reflect.apply(EventEmitter, undefined, [])).toThrow();
  const emitter = new EventEmitter();
  expect(Object.getPrototypeOf(emitter)).toBe(EventEmitter.prototype);
  expect(emitter._events).not.toBe(Reflect.get(receiver, "_events"));
  expect(Object.getOwnPropertyDescriptor(EventEmitter.prototype.removeAllListeners, "length")).toEqual({
    value: 1, writable: false, enumerable: false, configurable: true,
  });
  emitter.once("value", function original() {});
  const wrapper = emitter.rawListeners("value")[0];
  expect(wrapper.name).toBe("bound onceWrapper");
  expect(wrapper.length).toBe(0);
  expect(Object.getOwnPropertyDescriptor(wrapper, "listener")).toEqual({
    value: emitter.listeners("value")[0], writable: true, enumerable: true, configurable: true,
  });
});

test("emitted iterator retains its pending close result and FIFO error cleanup", async () => {
  const EventEmitter = runInNewContext(emitted)({});
  const emitter = new EventEmitter();
  const iterator = EventEmitter.on(emitter, "item", { close: ["done"] });
  const first = iterator.next();
  const second = iterator.next();
  emitter.emit("item", 1, 2);
  emitter.emit("done");
  expect(await first).toEqual({ value: [1, 2], done: false });
  expect(await second).toEqual({ value: undefined, done: true, close: true });
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
  const failed = EventEmitter.on(emitter, "item");
  const rejection = new Error("sentinel");
  const pending = failed.next();
  const ended = failed.next();
  emitter.emit("error", rejection);
  await expect(pending).rejects.toBe(rejection);
  expect(await ended).toEqual({ value: undefined, done: true });
  expect(emitter.eventNames()).toEqual([]);
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
emitter.removeAllListeners().removeAllListeners(key);
EventEmitter.call({});
EventEmitter.init.call({});
const prototype: BunWasm.Events.Prototype = EventEmitter.prototype;
const storage: BunWasm.Events.Table | undefined = prototype._events;
const initializedStorage: BunWasm.Events.Table = emitter._events;
const emitterSource: BunWasm.Events.Source = emitter;
const targetSource: BunWasm.Events.Source = new EventTarget();
const values: Promise<unknown[]> = EventEmitter.once(emitter, key);
const disposable = EventEmitter.addAbortListener(new AbortController().signal, listener);
const dispose = disposable[Symbol("optional")];
if (dispose !== undefined) dispose();
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
  ["absent disposal key", 'EventEmitter.addAbortListener(new AbortController().signal, () => {})[Symbol("never")]();'],
  ["prototype storage", 'EventEmitter.prototype._events["never"];'],
  ["prototype as initialized emitter", 'const value: BunWasm.Events.Emitter = EventEmitter.prototype;'],
  ["incomplete emitter source", 'const value: BunWasm.Events.Source = { on() { return emitter; } };'],
  ["incomplete target source", 'const value: BunWasm.Events.Source = { addEventListener() {} };'],
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

function intrinsicControl(body: string): Promise<unknown> {
  const factory = emitted.trim().replace(/;$/, "");
  return runInNewContext(`const E = (${factory})({}); (async () => { ${body} })()`, {
    AbortController, queueMicrotask,
  });
}

test("error monitor preserves concat and does not consume the mutable array iterator", async () => {
  const result = await intrinsicControl(`
    const emitter = new E(), calls = [];
    emitter.on(E.errorMonitor, value => calls.push(["monitor", value]));
    emitter.on("error", value => calls.push(["error", value]));
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
    const concat = Array.prototype.concat;
    const failure = new Error("iterator read");
    let concats = 0, caught = false;
    Array.prototype.concat = function () { concats++; return Reflect.apply(concat, this, arguments); };
    Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, get() { throw failure; } });
    try { emitter.emit("error", 42); } catch (error) { caught = error === failure; }
    finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
      Array.prototype.concat = concat;
    }
    return { calls, concats, caught };
  `);
  expect(result).toEqual({ calls: [["monitor", 42], ["error", 42]], concats: 1, caught: false });
});

test("error monitor retains concat species errors before listener delivery", async () => {
  const result = await intrinsicControl(`
    const emitter = new E(), calls = [];
    emitter.on(E.errorMonitor, value => calls.push(["monitor", value]));
    emitter.on("error", value => calls.push(["error", value]));
    const species = Object.getOwnPropertyDescriptor(Array, Symbol.species);
    const failure = new Error("species read");
    let caught = false;
    Object.defineProperty(Array, Symbol.species, { configurable: true, get() { throw failure; } });
    try { emitter.emit("error", 42); } catch (error) { caught = error === failure; }
    finally { Object.defineProperty(Array, Symbol.species, species); }
    return { calls, caught };
  `);
  expect(result).toEqual({ calls: [], caught: true });
});

for (const hook of ["iterator", "species"]) {
  test(`pending event retains shift delivery with a throwing ${hook}`, async () => {
    const result = await intrinsicControl(`
      const emitter = new E(), iterator = E.on(emitter, "value");
      let observed = "pending", caught = false;
      iterator.next().then(value => { observed = value; });
      const target = ${hook === "iterator" ? "Array.prototype" : "Array"};
      const key = Symbol.${hook};
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      const failure = new Error("hook read");
      Object.defineProperty(target, key, { configurable: true, get() { throw failure; } });
      try { emitter.emit("value", 42); } catch (error) { caught = error === failure; }
      finally { Object.defineProperty(target, key, descriptor); }
      await Promise.resolve();
      await iterator.return();
      return { observed, caught, listeners: emitter.eventNames() };
    `);
    expect(result).toEqual({ observed: { value: [42], done: false }, caught: false, listeners: [] });
  });

  for (const event of ["error", "close"]) {
    test(`pending ${event} delivers before the original finish ${hook} hook`, async () => {
      const result = await intrinsicControl(`
        const emitter = new E(), iterator = E.on(emitter, "value", { close: ["close"] });
        const rejection = new Error("event error"), failure = new Error("hook read");
        let observed = "pending", caught = false;
        iterator.next().then(value => { observed = value; }, error => { observed = error === rejection; });
        const target = ${hook === "iterator" ? "Array.prototype" : "Array"};
        const key = Symbol.${hook};
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, { configurable: true, get() { throw failure; } });
        try { emitter.emit("${event}", rejection); } catch (error) { caught = error === failure; }
        finally { Object.defineProperty(target, key, descriptor); }
        await Promise.resolve();
        await iterator.return();
        return { observed, caught };
      `);
      expect(result).toEqual({
        observed: event === "error" ? true : { value: undefined, done: true, close: true },
        caught: true,
      });
    });
  }

  for (const event of ["value", "close"]) {
    test(`queued ${event} next retains shift without ${hook} access or a synchronous throw`, async () => {
      const result = await intrinsicControl(`
        const emitter = new E(), iterator = E.on(emitter, "value", { close: ["close"] });
        emitter.emit("${event}", 42);
        const target = ${hook === "iterator" ? "Array.prototype" : "Array"};
        const key = Symbol.${hook};
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        const failure = new Error("hook read");
        let pending, caught = false;
        Object.defineProperty(target, key, { configurable: true, get() { throw failure; } });
        try { pending = iterator.next(); } catch (error) { caught = error === failure; }
        finally { Object.defineProperty(target, key, descriptor); }
        const observed = await pending;
        await iterator.return();
        return { observed, caught };
      `);
      expect(result).toEqual({
        observed: event === "value" ? { value: [42], done: false } : { value: undefined, done: true },
        caught: false,
      });
    });
  }
}

for (const event of ["value", "error", "close"]) {
  test(`pending ${event} preserves shift calls, receiver and thrown identity`, async () => {
    const result = await intrinsicControl(`
      const emitter = new E(), iterator = E.on(emitter, "value", { close: ["close"] });
      let observed = "pending", caught = false;
      iterator.next().then(value => { observed = value; }, error => { observed = error; });
      const shift = Array.prototype.shift, lengths = [], failure = new Error("shift failed");
      let receiver;
      Array.prototype.shift = function () {
        receiver = this;
        lengths.push(this.length);
        throw failure;
      };
      try { emitter.emit("${event}", 42); } catch (error) { caught = error === failure; }
      finally { Array.prototype.shift = shift; }
      await Promise.resolve();
      const pending = observed === "pending";
      const waiter = receiver[0];
      const waiterRetained = typeof waiter.resolve === "function" && typeof waiter.reject === "function";
      await iterator.return();
      return { pending, caught, lengths, waiterRetained, listeners: emitter.eventNames() };
    `);
    expect(result).toEqual({ pending: true, caught: true, lengths: [1], waiterRetained: true, listeners: [] });
  });
}

test("pending close retains waiter shift, resolve lookup and value shift ordering", async () => {
  const result = await intrinsicControl(`
    const emitter = new E(), iterator = E.on(emitter, "value", { close: ["close"] });
    const first = iterator.next();
    const shift = Array.prototype.shift, calls = [];
    Array.prototype.shift = function () {
      calls.push(this.length);
      const value = Reflect.apply(shift, this, arguments);
      if (typeof value.resolve === "function") {
        const resolve = value.resolve;
        Object.defineProperty(value, "resolve", { get() { calls.push("resolve"); return resolve; } });
      }
      return value;
    };
    try { emitter.emit("close"); }
    finally { Array.prototype.shift = shift; }
    return { observed: await first, calls };
  `);
  expect(result).toEqual({ observed: { value: undefined, done: true, close: true }, calls: [1, "resolve", 1] });
});

for (const event of ["value", "close"]) {
  test(`queued ${event} preserves one shift and thrown identity synchronously`, async () => {
    const result = await intrinsicControl(`
      const emitter = new E(), iterator = E.on(emitter, "value", { close: ["close"] });
      emitter.emit("${event}", 42);
      const shift = Array.prototype.shift, lengths = [], failure = new Error("shift failed");
      let caught = false;
      Array.prototype.shift = function () { lengths.push(this.length); throw failure; };
      try { iterator.next(); } catch (error) { caught = error === failure; }
      finally { Array.prototype.shift = shift; }
      const observed = await iterator.next();
      await iterator.return();
      return { caught, lengths, observed };
    `);
    expect(result).toEqual({
      caught: true, lengths: [1],
      observed: event === "value" ? { value: [42], done: false } : { value: undefined, done: true },
    });
  });
}

for (const mode of ["native", "fallback"]) {
  test(`disposal has only its actual key and preserves cleanup in ${mode} symbol mode`, async () => {
    const symbol = mode === "native" ? Symbol : Object.assign(
      (description?: string) => Symbol(description),
      { for: Symbol.for, asyncIterator: Symbol.asyncIterator },
    );
    const EventEmitter = runInNewContext(emitted, { Symbol: symbol, queueMicrotask })({});
    const key = mode === "native" ? Symbol.dispose : Symbol.for("Symbol.dispose");
    const controller = new AbortController();
    let count = 0;
    const handle = EventEmitter.addAbortListener(controller.signal, () => { count++; });
    expect(Reflect.ownKeys(handle)).toEqual([key]);
    expect(() => handle[Symbol("never")]()).toThrow(TypeError);
    handle[key]();
    controller.abort();
    expect(count).toBe(0);
    const already = EventEmitter.addAbortListener(controller.signal, () => { count++; });
    already[key]();
    await Promise.resolve();
    expect(count).toBe(1);
  });
}
