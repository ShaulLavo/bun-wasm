import assert from "node:assert/strict";
import E from "node:events";

async function absentShift(site: string, replaceTypeError: boolean) {
  const emitter = new E();
  const iterator = E.on(emitter, "value", { close: ["close"] });
  const observed: unknown[] = ["pending", "pending"];
  if (site === "next queue") emitter.emit("value", 42);
  else {
    iterator.next().then(value => { observed[0] = value; }, error => { observed[0] = error; });
    iterator.next().then(value => { observed[1] = value; }, error => { observed[1] = error; });
  }
  const shift = Array.prototype.shift;
  const OriginalTypeError = TypeError;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "TypeError");
  if (descriptor === undefined) throw new Error("missing TypeError descriptor");
  const sentinel = new Error("global TypeError getter");
  const calls: string[] = [];
  let caught = "none";
  Object.defineProperty(Array.prototype, "shift", { configurable: true, writable: true, value: function (this: unknown[]) {
    const value: unknown = Reflect.apply(shift, this, arguments);
    const waiter = typeof value === "object" && value !== null && Object.hasOwn(value, "resolve");
    calls.push(waiter ? "shift waiter" : "shift queue");
    if (site !== "settleClose queue" || !waiter) return undefined;
    const resolve = Reflect.get(value, "resolve");
    Object.defineProperty(value, "resolve", { get() { calls.push("get resolve"); return resolve; } });
    return value;
  } });
  if (replaceTypeError) Object.defineProperty(globalThis, "TypeError", {
    configurable: true, get() { calls.push("get TypeError"); throw sentinel; },
  });
  try {
    if (site === "next queue") iterator.next();
    else emitter.emit(site === "onError waiter" ? "error" : site.startsWith("settleClose") ? "close" : "value", 42);
  } catch (error) { caught = error === sentinel ? "sentinel" : error instanceof OriginalTypeError ? "TypeError" : "other"; }
  finally {
    Array.prototype.shift = shift;
    Object.defineProperty(globalThis, "TypeError", descriptor);
  }
  await Promise.resolve();
  const snapshot = { calls, caught, observed: observed.slice(), listeners: emitter.eventNames() };
  await iterator.return?.();
  assert.deepEqual(emitter.eventNames(), []);
  return snapshot;
}

function installWrapFnAccessor({ state, wrapped, listener, emitter, mode, sentinel, calls }: {
  state: object;
  wrapped: object;
  listener: (this: unknown, value: unknown) => void;
  emitter: E;
  mode: string;
  sentinel: Error;
  calls: unknown[];
}) {
  if (mode === "shape") return;
  let stored: unknown, reentered = false;
  Object.defineProperty(state, "wrapFn", {
    configurable: true,
    set(value: unknown) {
      calls.push(["set", value === wrapped, Reflect.get(wrapped, "listener") === listener]);
      if (mode === "setter") throw sentinel;
      stored = value;
    },
    get() {
      calls.push("get");
      if (mode === "getter") throw sentinel;
      if (!reentered) { reentered = true; emitter.emit("value", "inner"); }
      return stored;
    },
  });
}

function boundState(method: "once" | "prependOnceListener", mode: string) {
  const emitter = new E();
  const bind = Function.prototype.bind;
  const sentinel = new Error("wrapFn accessor");
  const calls: unknown[] = [];
  const keys: string[][] = [];
  let initialOwn = false, initialUndefined = false, caught = false, registeredWrapper: unknown;
  function listener(this: unknown, value: unknown) { calls.push(["listener", value, this === emitter]); }
  emitter.on("removeListener", type => { if (type === "value") calls.push("remove"); });
  Object.defineProperty(Function.prototype, "bind", { configurable: true, writable: true, value: function (this: Function, state: object) {
    keys.push(Object.keys(state));
    initialOwn = Object.hasOwn(state, "wrapFn");
    initialUndefined = Reflect.get(state, "wrapFn") === undefined;
    const wrapped: object = Reflect.apply(bind, this, arguments);
    registeredWrapper = wrapped;
    installWrapFnAccessor({ state, wrapped, listener, emitter, mode, sentinel, calls });
    return wrapped;
  } });
  try { emitter[method]("value", listener); }
  catch (error) { caught = error === sentinel; }
  finally { Function.prototype.bind = bind; }
  const registered = emitter.rawListeners("value")[0] === registeredWrapper;
  try { emitter.emit("value", "outer"); emitter.emit("value", "again"); }
  catch (error) { caught = error === sentinel; }
  const snapshot = { keys, initialOwn, initialUndefined, caught, registered, listeners: emitter.listenerCount("value"), calls: calls.slice() };
  emitter.removeAllListeners();
  return snapshot;
}

for (const site of ["settle waiter", "onError waiter", "settleClose waiter", "settleClose queue", "next queue"]) {
  for (const replaceTypeError of [false, true]) {
    const result = await absentShift(site, replaceTypeError);
    const closes = site === "settleClose queue";
    assert.deepEqual(result, {
      calls: closes ? ["shift waiter", "get resolve", "shift queue"] : [site === "next queue" ? "shift queue" : "shift waiter"],
      caught: closes ? "none" : "TypeError",
      observed: closes ? [undefined, { value: undefined, done: true }] : ["pending", "pending"],
      listeners: closes ? [] : ["value", "error", "close"],
    });
  }
  console.log(`${site} retains raw absent-result behavior without global TypeError access`);
}
for (const method of ["once", "prependOnceListener"] satisfies ("once" | "prependOnceListener")[]) {
  for (const mode of ["shape", "setter", "getter", "reentrant"]) {
    const result = boundState(method, mode);
    const calls = mode === "shape" ? ["remove", ["listener", "outer", true]]
      : mode === "setter" ? [["set", true, true]]
      : mode === "getter" ? [["set", true, true], "get"]
      : [["set", true, true], "get", "get", "remove", ["listener", "inner", true], ["listener", "outer", true]];
    assert.deepEqual(result, {
      keys: [["fired", "wrapFn", "target", "type", "listener"]], initialOwn: true, initialUndefined: true,
      caught: mode === "setter" || mode === "getter", registered: mode !== "setter", listeners: mode === "getter" ? 1 : 0, calls,
    });
  }
  console.log(`${method} retains bind state, wrapFn accessors and reentrant order`);
}
