// AsyncLocalStorage after rejected awaits, in catch and finally blocks, async
// generators and for await. Node runs this file as the reference;
// web/guest-tests/browser.test.ts runs it on the browser engine, whose
// printed hooks (vendor patch 0008) carry the frames, and compares the output
// line for line. The cases are the CTX design probes P1, P2, P4 and P5.
import { AsyncLocalStorage } from "node:async_hooks";

type Rejection = { id: string };
type Tools = {
  note: (phase: string, id?: string) => void;
  tick: <T>(value?: T) => Promise<T | undefined>;
  rej: (id: string) => Promise<never>;
};

const als = new AsyncLocalStorage<string>();
const store = () => als.getStore() ?? "none";
const idOf = (error: unknown) => (error as Rejection).id;
const print = (line: string) => console.log(line);

// P1: two overlapping requests through nine rejection scenarios.
async function c1(t: Tools) {
  try {
    await t.tick();
    await t.rej("c1");
  } catch (error) {
    t.note("c1.catch", idOf(error));
  } finally {
    t.note("c1.finally");
  }
}

async function c2(t: Tools) {
  try {
    try {
      await t.rej("c2");
    } finally {
      t.note("c2.inner-finally");
    }
  } catch (error) {
    t.note("c2.outer-catch", idOf(error));
  }
}

async function c3(t: Tools) {
  try {
    try {
      await t.rej("c3a");
    } catch {
      t.note("c3.catch");
      await t.rej("c3b");
    } finally {
      t.note("c3.finally");
    }
  } catch (error) {
    t.note("c3.outer", idOf(error));
  }
}

async function c4(t: Tools) {
  try {
    await t.tick();
    als.enterWith(`${store()}:entered`);
    throw { id: "c4" };
  } catch (error) {
    t.note("c4.catch", idOf(error));
  }
}

async function c5(t: Tools) {
  try {
    await (await t.tick({ v: () => t.rej("c5") }))!.v();
  } catch (error) {
    t.note("c5.catch", idOf(error));
  }
}

async function c6(t: Tools) {
  async function* gen() {
    yield 1;
    await t.tick();
    throw { id: "c6" };
  }
  try {
    for await (const _ of gen()) t.note("c6.body");
  } catch (error) {
    t.note("c6.catch", idOf(error));
  }
}

async function c7(t: Tools) {
  async function* gen() {
    try {
      yield 1;
      yield 2;
    } finally {
      await t.tick();
    }
  }
  try {
    for await (const _ of gen()) break;
    t.note("c7.after-loop");
  } catch {
    t.note("c7.unexpected");
  }
}

async function c8(t: Tools) {
  const inner = async () => {
    try {
      return await t.rej("c8");
    } finally {
      t.note("c8.finally");
    }
  };
  try {
    await inner();
  } catch (error) {
    t.note("c8.catch", idOf(error));
  }
}

async function c9(t: Tools) {
  function* source() {
    yield t.tick(1);
    yield t.rej("c9");
  }
  try {
    for await (const _ of source()) {
      t.note("c9.body");
      await t.tick();
    }
  } catch (error) {
    t.note("c9.catch", idOf(error));
  }
}

async function rejectionRequest(name: string, ms: number, observations: string[]) {
  const t: Tools = {
    note: (phase, id) => observations.push(`${name} ${phase}${id ? ` ${id}` : ""} store=${store()}`),
    tick: value => new Promise(ok => setTimeout(() => ok(value), ms)),
    rej: id => new Promise((_, no) => setTimeout(() => no({ id }), ms)),
  };
  await als.run(name, async () => {
    for (const scenario of [c1, c2, c3, c4, c5, c6, c7, c8, c9]) await scenario(t);
    t.note("end");
  });
}

async function p1() {
  const observations: string[] = [];
  // Distinct delays make A and B interleave at every step.
  await Promise.all([rejectionRequest("A", 2, observations), rejectionRequest("B", 1, observations)]);
  const mismatches = observations.filter(line => !line.endsWith(`store=${line[0]}`) && !line.endsWith(`store=${line[0]}:entered`));
  print(`P1 observations=${observations.length} mismatches=${mismatches.length}`);
  for (const line of observations.sort()) print(`P1 ${line}`);
}

// P2: the hooked shapes keep rejection identity, accessor reads, the
// for-await protocol and job interleaving.
async function semantics(log: (key: string, value: unknown) => void) {
  const reason = { tag: "reason" };
  try {
    await Promise.reject(reason);
  } catch (error) {
    log("identity", error === reason);
  }
  const p = Promise.resolve(1);
  let ctorReads = 0;
  Object.defineProperty(p, "constructor", { get() { ctorReads++; return Promise; } });
  log("value", await p);
  log("ctorReads", ctorReads);
  let thenReads = 0;
  let thenCalls = 0;
  const thenable = { get then() { thenReads++; return (ok: (value: number) => void) => { thenCalls++; ok(2); }; } };
  log("thenable", await thenable);
  log("thenReads", thenReads);
  log("thenCalls", thenCalls);
  // A thenable that rejects; typed as a promise only for the type checker.
  const bad = { then(_: unknown, no: (reason: unknown) => void) { no(reason); } } as unknown as PromiseLike<never>;
  try {
    await bad;
  } catch (error) {
    log("thenableIdentity", error === reason);
  }
  class Sub extends Promise<number> {}
  const s = Sub.resolve(3);
  let subThen = 0;
  const subThenFn = s.then;
  Object.defineProperty(s, "then", { get() { subThen++; return subThenFn; } });
  log("sub", await s);
  log("subThenReads", subThen);
  const rejected = Promise.reject(reason);
  let rejCtor = 0;
  Object.defineProperty(rejected, "constructor", { get() { rejCtor++; return Promise; } });
  try {
    await rejected;
  } catch (error) {
    log("rejectedIdentity", error === reason);
  }
  log("rejectedCtorReads", rejCtor);
  log("forAwaitProtocol", await forAwaitProtocol());
  log("order", await jobOrder(reason));
}

function protocolIterable(trace: string[]) {
  let i = 0;
  const iterator = {
    get next() {
      trace.push("next-get");
      return () => {
        trace.push("next");
        return Promise.resolve({ done: i >= 2, value: i++ });
      };
    },
    get return() {
      trace.push("return-get");
      return () => {
        trace.push("return");
        return Promise.resolve({ done: true, value: undefined });
      };
    },
  };
  return {
    get [Symbol.asyncIterator]() {
      trace.push("iter");
      return () => iterator;
    },
  };
}

async function forAwaitProtocol() {
  const trace: string[] = [];
  for await (const v of protocolIterable(trace)) {
    trace.push(`body${v}`);
    if (v === 1) break;
  }
  return trace.join(",");
}

async function jobOrder(reason: unknown) {
  const order: string[] = [];
  const push = (step: string) => () => order.push(step);
  const chain = Promise.resolve().then(push("t1")).then(push("t2")).then(push("t3")).then(push("t4")).then(push("t5"));
  order.push("a0");
  await null;
  order.push("a1");
  await undefined;
  order.push("a2");
  try {
    await Promise.reject(reason);
  } catch {
    order.push("a3");
  } finally {
    order.push("a4");
  }
  await chain;
  return order.join(",");
}

async function p2() {
  const log = (key: string, value: unknown) => print(`P2 ${key}=${value}`);
  await als.run("p2", () => semantics(log));
}

// P4: generator bodies after yield, throw() and return().
function generators(note: (phase: string) => void) {
  function* sync() {
    note("sync.enter");
    yield 1;
    note("sync.after-yield");
  }
  async function* agen() {
    note("agen.enter");
    yield 1;
    note("agen.after-yield");
    await null;
    note("agen.after-await");
    try {
      yield Promise.reject({ id: "y" });
    } catch {
      note("agen.yield-rejected-catch");
    }
    yield 2;
    note("agen.after-yield-2");
  }
  async function* inner() {
    yield 1;
    yield 2;
    await null;
    throw { id: "inner" };
  }
  async function* outer() {
    try {
      yield* inner();
    } catch {
      note("delegate.catch");
    }
  }
  async function* thrower() {
    try {
      yield 1;
    } catch {
      note("throw.catch");
    } finally {
      note("throw.finally");
    }
  }
  async function* returner() {
    try {
      yield 1;
    } finally {
      note("return.finally");
    }
  }
  return { sync, agen, outer, thrower, returner };
}

async function p4() {
  const note = (phase: string) => print(`P4 ${phase}=${store()}`);
  const { sync, agen, outer, thrower, returner } = generators(note);
  const s = als.run("created", () => sync());
  als.run("next1", () => s.next());
  als.run("next2", () => s.next());
  const g = als.run("created", () => agen());
  for (const frame of ["next1", "next2", "next3", "next4", "next5"]) await als.run(frame, () => g.next());
  const d = als.run("created", () => outer());
  for (const frame of ["d1", "d2", "d3"]) await als.run(frame, () => d.next());
  const t = als.run("created", () => thrower());
  await als.run("t1", () => t.next());
  await als.run("t2", () => t.throw(new Error("thrown")));
  const r = als.run("created", () => returner());
  await als.run("r1", () => r.next());
  await als.run("r2", () => r.return(undefined));
}

// P5: enterWith and abrupt exits in for await bodies.
async function* two() {
  yield 1;
  yield 2;
}

async function* failSecond() {
  yield 1;
  await null;
  throw { id: "f" };
}

async function forAwaitCases(note: (phase: string) => void) {
  try {
    for await (const _ of two()) {
      als.enterWith("a-entered");
      throw { id: "a" };
    }
  } catch {
    note("a.catch");
  }
  await forAwaitBreak(note);
  try {
    for await (const _ of two()) {
      als.enterWith("c-entered");
      await Promise.reject({ id: "c" });
    }
  } catch {
    note("c.catch");
  }
  await forAwaitCarry(note);
}

async function forAwaitBreak(note: (phase: string) => void) {
  for await (const _ of two()) {
    als.enterWith("b-entered");
    try {
      note("b.try");
    } finally {
      note("b.finally");
    }
    break;
  }
  note("b.after-loop");
}

async function forAwaitCarry(note: (phase: string) => void) {
  for await (const _ of two()) {
    note("d.body");
    als.enterWith("d-entered");
  }
  note("d.after-loop");
  try {
    for await (const _ of failSecond()) {
      note("e.body");
      als.enterWith("e-entered");
    }
  } catch {
    note("e.catch");
  }
  await forAwaitLabels(note);
}

async function forAwaitLabels(note: (phase: string) => void) {
  outer: for await (const x of two()) {
    for await (const y of two()) {
      note("f.inner");
      als.enterWith(`f-${x}${y}`);
      continue outer;
    }
  }
  note("f.after-loop");
  first: second: for await (const x of two()) {
    note("g.body");
    als.enterWith(`g-${x}`);
    if (x === 1) continue second;
    break first;
  }
  note("g.after-loop");
}

async function p5() {
  const note = (phase: string) => print(`P5 ${phase}=${store()}`);
  await als.run("req", () => forAwaitCases(note));
}

await p1();
await p2();
await p4();
await p5();

// Module top level: it awaits and has handlers, so it is hooked like an
// async function body. Another request interleaves with its rejection.
const other = als.run("other", async () => {
  for (let i = 0; i < 4; i++) await new Promise(ok => setTimeout(ok, 1));
});
als.enterWith("top");
try {
  await new Promise((_, no) => setTimeout(() => no({ id: "top" }), 2));
} catch (error) {
  print(`TOP catch ${idOf(error)}=${store()}`);
} finally {
  print(`TOP finally=${store()}`);
}
await other;
print(`TOP end=${store()}`);
