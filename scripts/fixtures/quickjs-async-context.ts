declare function nativeGet(): unknown;
declare function nativeSet(frame: unknown): void;
declare function nativeDrain(): void;
declare function print(text: string): void;
declare const storage: {
  getStore(): unknown;
  run<T>(frame: unknown, callback: () => T): T;
  enterWith(frame: unknown): void;
};
declare function runInContext<T>(frame: unknown, callback: () => T, receiver: unknown, args: unknown[]): T;

const observations: { label: string; pass: boolean }[] = [];
function observe(label: string, expected: unknown, actual: unknown = storage.getStore() ?? null) {
  observations.push({ label, pass: Object.is(actual, expected) });
}
function assert(label: string, pass: boolean) { observe(label, true, pass); }
function outside(label: string) {
  observe(label + ".sync", null);
  Promise.resolve().then(() => observe(label + ".job", null));
}
function gate() {
  let release: (value: unknown) => void = () => { throw Error("gate not ready"); };
  const promise = new Promise<unknown>(resolve => { release = resolve; });
  return { promise, release };
}
const NativeAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const originalThen = Promise.prototype.then;
const reason = {};
const value = {};

function operand(id: string, outcome: string, trace: string[]) {
  const thenable = { get then() {
    trace.push("get");
    observe(id + ".get", id);
    storage.enterWith(id + ".getter");
    return function (this: unknown, resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      trace.push("call");
      observe(id + ".call", id + ".getter");
      assert(id + ".receiver", this === thenable);
      assert(id + ".arguments", arguments.length === 2);
      storage.enterWith(id + ".changed");
      if (outcome === "throw") throw reason;
      if (outcome === "reject") return reject(reason);
      resolve(value);
    };
  } };
  return thenable;
}
async function assimilation(id: string, outcome: string, returned: boolean) {
  const trace: string[] = [];
  const fn = new NativeAsyncFunction("operand", returned ? "return operand;" : "return await operand;");
  const pending = storage.run(id, () => fn(operand(id, outcome, trace)));
  outside(id + ".outside");
  Promise.resolve().then(() => trace.push("marker"));
  try {
    assert(id + ".fulfilled", await pending === value && outcome === "fulfill");
  } catch (caught) {
    assert(id + ".rejected", caught === reason && outcome !== "fulfill");
  }
  assert(id + ".order", trace.join() === "get,call,marker");
  observe(id + ".outside.after", null);
}
async function deferred() {
  const first = gate();
  const second = gate();
  const trace: string[] = [];
  storage.run("one", () => first.release(operand("one", "fulfill", trace)));
  outside("one.outside");
  storage.run("two", () => second.release(operand("two", "reject", trace)));
  outside("two.outside");
  const results = await Promise.allSettled([first.promise, second.promise]);
  assert("overlap.fulfill", results[0]?.status === "fulfilled" && results[0].value === value);
  assert("overlap.reject", results[1]?.status === "rejected" && results[1].reason === reason);
  observe("overlap.outside", null);
}
async function nested() {
  const trace: string[] = [];
  const pending = storage.run("nested", () => Promise.resolve({ then(resolve: (value: unknown) => void) {
    observe("nested.call", "nested");
    storage.enterWith("nested.inner");
    resolve(operand("nested.inner", "fulfill", trace));
    Promise.resolve().then(() => observe("nested.child.job", "nested.inner.getter"));
    nativeDrain();
    observe("nested.after.reentrant.drain", "nested.inner.getter");
    storage.enterWith("nested.discard");
  } }));
  outside("nested.outside");
  assert("nested.result", await pending === value);
  observe("nested.after", null);
}
async function falsyFrames() {
  const frames = [undefined, null, false, 0, -0, NaN, "", 0n, {}];
  for (const [index, frame] of frames.entries()) await falsyFrame(index, frame);
}
async function falsyFrame(index: number, frame: unknown) {
  const pending = runInContext({ before: true }, () => Promise.resolve({ get then() {
    nativeSet(frame);
    return (resolve: (value: unknown) => void) => {
      assert("raw.frame." + index, Object.is(nativeGet(), frame));
      nativeSet({ mutation: index });
      resolve(value);
    };
  } }), undefined, []);
  outside("raw.outside." + index);
  assert("raw.result." + index, await pending === value);
}
async function nativeAwait() {
  const failures = [undefined, null, false, 0, -0, NaN, "", 0n, reason];
  for (const [index, failure] of failures.entries()) await rejectAwait(index, failure);
  const receiver = {};
  const fn = new NativeAsyncFunction("first", "receiver", `"use strict";
    const args = arguments; await Promise.resolve();
    return [this === receiver, args === arguments, arguments[0] === first, new.target === undefined];`);
  const checks = await storage.run("native", () => Reflect.apply(fn, receiver, [value, receiver]));
  assert("native.receiver.arguments", checks.every(Boolean));
  outside("native.outside");
}
async function rejectAwait(index: number, failure: unknown) {
  await storage.run("native.reject", async () => {
    try { await Promise.reject(failure); }
    catch (caught) {
      assert("native.reject.identity." + index, Object.is(caught, failure));
      observe("native.reject.frame." + index, "native.reject");
    } finally { observe("native.finally." + index, "native.reject"); }
  });
  observe("native.reject.outside." + index, null);
}
async function getterSemantics(kind: string) {
  const trace: string[] = [];
  let reads = 0;
  const promise = kind === "reject" ? Promise.reject(reason) : Promise.resolve(value);
  Object.defineProperty(promise, "constructor", { get() {
    reads++;
    trace.push("constructor");
    observe(kind + ".constructor.frame", "getter");
    if (kind === "throw") throw reason;
    if (kind === "change") storage.enterWith("changed");
    return Promise;
  } });
  const pending = storage.run("getter", async () => {
    trace.push("operand");
    try {
      assert(kind + ".await.value", await promise === value && kind !== "reject");
    } catch (caught) {
      assert(kind + ".await.reason", caught === reason && (kind === "reject" || kind === "throw"));
    } finally {
      observe(kind + ".await.finally", kind === "change" ? "changed" : "getter");
    }
    observe(kind + ".await.frame", kind === "change" ? "changed" : "getter");
    trace.push("continuation");
  });
  outside(kind + ".outside");
  Promise.resolve().then(() => trace.push("marker"));
  await pending;
  await 0;
  assert(kind + ".constructor.reads", reads === 1);
  const expected = "operand,constructor,continuation,marker";
  assert(kind + ".constructor.order", trace.join() === expected);
}
function constructorThrow() {
  let reads = 0;
  const promise = Promise.resolve(value);
  Object.defineProperty(promise, "constructor", { get() {
    reads++;
    observe("throw.constructor.frame", "getter.throw");
    assert("throw.constructor.receiver", this === promise);
    throw reason;
  } });
  storage.run("getter.throw", () => {
    try { Promise.resolve(promise); }
    catch (caught) { assert("throw.constructor.identity", caught === reason); }
  });
  assert("throw.constructor.reads", reads === 1);
  outside("throw.constructor.outside");
}
function* generator() {
  try { yield "body"; }
  finally { observe("generator.finally", "generator"); yield "finally"; }
  return "done";
}
async function generators() {
  await storage.run("generator", async () => {
    const returning = generator();
    assert("generator.body", returning.next().value === "body");
    await 0;
    assert("generator.return.finally", returning.return("returned").value === "finally");
    assert("generator.return.result", returning.next().value === "returned");
    const throwing = generator();
    throwing.next();
    assert("generator.throw.finally", throwing.throw(reason).value === "finally");
    await 0;
    try { throwing.next(); }
    catch (caught) { assert("generator.throw.identity", caught === reason); }
  });
  outside("generator.outside");
}
let stage = "assimilation";
async function main() {
  await Promise.all([assimilation("await.fulfill", "fulfill", false), assimilation("await.reject", "reject", false),
    assimilation("await.throw", "throw", false), assimilation("return.fulfill", "fulfill", true),
    assimilation("return.reject", "reject", true), assimilation("return.throw", "throw", true)]);
  stage = "deferred";
  await deferred();
  stage = "nested";
  await nested();
  stage = "falsy";
  await falsyFrames();
  stage = "nativeAwait";
  await nativeAwait();
  for (const kind of ["fulfill", "reject", "change", "throw"]) {
    stage = "getter." + kind;
    await getterSemantics(kind);
  }
  constructorThrow();
  stage = "generators";
  await generators();
  await 0;
  outside("final.outside");
  await 0;
  assert("Promise.prototype.then unchanged", originalThen === Promise.prototype.then);
  const failures = observations.filter(row => !row.pass);
  print(JSON.stringify({ observations: observations.length, failures }));
  Object.assign(globalThis, { contractDone: true, contractFailures: failures.length });
}
main().catch(error => {
  print(JSON.stringify({ stage, error: String(error), observations: observations.length, failures: observations.filter(row => !row.pass) }));
  Object.assign(globalThis, { contractDone: false });
});
