// Node's Timeout and Immediate internals that libraries read and write:
// _destroyed, _idleStart, hasRef, refresh, string ids and util.promisify.
import { rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import * as timersPromises from "node:timers/promises";

type Internal = { _destroyed: boolean; _idleStart: unknown; hasRef(): boolean; refresh(): unknown };
const internals = (timer: unknown) => timer as Internal;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function destroyed() {
  const timeout = internals(setTimeout(() => {}, 0));
  const interval = internals(setInterval(() => {}, 0));
  const immediate = internals(setImmediate(() => {}));
  console.log("default", timeout._destroyed, interval._destroyed, immediate._destroyed);
  clearTimeout(timeout as never);
  clearInterval(interval as never);
  clearImmediate(immediate as never);
  console.log("cleared", timeout._destroyed, interval._destroyed, immediate._destroyed);

  const seen: string[] = [];
  await new Promise<void>(resolve => {
    const t = internals(setTimeout(() => {
      seen.push(`timeout in callback ${t._destroyed} ${t.hasRef()}`);
      setImmediate(() => {
        seen.push(`timeout after callback ${t._destroyed} ${t.hasRef()}`);
        resolve();
      });
    }, 1));
  });
  await new Promise<void>(resolve => {
    const i = internals(setImmediate(() => {
      seen.push(`immediate in callback ${i._destroyed} ${i.hasRef()}`);
      setImmediate(() => {
        seen.push(`immediate after callback ${i._destroyed} ${i.hasRef()}`);
        resolve();
      });
    }));
  });
  await new Promise<void>(resolve => {
    const t = internals(setTimeout(() => {
      clearTimeout(t as never);
      seen.push(`cleared in callback ${t._destroyed}`);
      resolve();
    }, 1));
  });
  console.log(seen.join("\n"));
}

async function refresh() {
  let fired = 0;
  const t = internals(setTimeout(() => {
    fired++;
    if (fired === 1) {
      t.refresh();
      console.log("refreshed in callback", t._destroyed, t.hasRef());
    }
  }, 2));
  for (let i = 0; i < 200 && fired < 2; i++) await tick();
  await tick();
  console.log("refresh in callback fired", fired, t._destroyed);

  t.refresh();
  console.log("refresh after firing", t._destroyed, t.hasRef());
  for (let i = 0; i < 200 && fired < 3; i++) await tick();
  console.log("refresh after firing fired", fired, t._destroyed);

  const cleared = internals(setTimeout(() => console.log("cleared timer fired"), 1));
  clearTimeout(cleared as never);
  cleared.refresh();
  console.log("refresh after clear", cleared._destroyed, cleared.hasRef());
  await tick();
}

async function stringIds() {
  const fired: string[] = [];
  const kept = setTimeout(() => fired.push("kept"), 1);
  const id = String(+kept);
  for (const bad of [" " + id, id + " ", "0" + id, "+" + id, id + ".0", (2 ** 64).toString(), ""]) clearTimeout(bad as never);
  const cleared = setTimeout(() => fired.push("cleared"), 1);
  clearTimeout(String(+cleared) as never);
  const interval = setInterval(() => fired.push("interval"), 1);
  clearInterval(String(+interval) as never);
  const immediate = setImmediate(() => fired.push("immediate"));
  clearTimeout(immediate as never);
  clearInterval(immediate as never);
  await tick();
  await tick();
  console.log("string ids", fired.join(","));
}

async function idleStart() {
  const t = internals(setTimeout(() => {}, 10));
  console.log("idleStart is a number", typeof t._idleStart === "number" && Number.isFinite(t._idleStart));
  t._idleStart = "not a number";
  console.log("non-number kept", t._idleStart);
  t._idleStart = Infinity;
  console.log("infinity kept", t._idleStart);
  clearTimeout(t as never);
  t._idleStart = 0;
  console.log("cleared write kept", t._idleStart);

  for (let i = 0; i < 20; i++) {
    const order: string[] = [];
    await new Promise<void>(resolve => {
      const t1 = internals(setTimeout(() => {
        order.push("t1");
        setImmediate(() => order.push("immediate"));
      }));
      const start = performance.now();
      while (performance.now() - start < 2) {}
      const t2 = internals(setTimeout(() => {
        order.push("t2");
        setImmediate(resolve);
      }));
      t2._idleStart = t1._idleStart;
    });
    if (order.join(",") !== "t1,t2,immediate") {
      console.log("wrong order", order.join(","), "on iteration", i);
      return;
    }
  }
  console.log("shared deadline order t1,t2,immediate");
}

// An interval is re-armed after its callback from the time it fired, so a
// refresh() or _idleStart write inside the callback cannot keep the timers
// phase running ahead of a queued immediate.
async function intervalWritesInCallback() {
  for (const mode of ["minus10", "zero", "refresh"]) {
    await new Promise<void>(resolve => {
      let runs = 0;
      const iv = internals(setInterval(() => {
        runs++;
        if (mode === "minus10") iv._idleStart = (iv._idleStart as number) - 10;
        else if (mode === "zero") iv._idleStart = 0;
        else iv.refresh();
        if (runs === 1) setImmediate(() => {
          console.log("interval", mode, "immediate after", runs, "runs");
          clearInterval(iv as never);
          resolve();
        });
        if (runs > 1000) {
          console.log("interval", mode, "runaway");
          clearInterval(iv as never);
          resolve();
        }
      }, 5));
    });
  }
  await new Promise<void>(resolve => {
    const iv = internals(setInterval(() => {
      iv._idleStart = 0;
      console.log("interval write kept in callback", iv._idleStart === 0);
      setImmediate(() => {
        clearInterval(iv as never);
        resolve();
      });
    }, 5));
  });
}

// Every timer due when the timers phase starts runs before an immediate one of them queues.
// Native Bun and Node read the clock once per phase, so the script waits past both
// deadlines: two setTimeout(0) calls can land in different milliseconds on a slow host,
// and then b is not due yet when a runs (a,c,b in Bun and Node too).
async function dueTimersBeforeImmediates() {
  const order: string[] = [];
  await new Promise<void>(resolve => {
    setTimeout(() => {
      order.push("a");
      setImmediate(() => {
        order.push("c");
        resolve();
      });
    }, 0);
    setTimeout(() => order.push("b"), 0);
    const due = performance.now() + 5;
    while (performance.now() < due);
  });
  console.log("due timers", order.join(","));
}

async function promisified() {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  for (const fn of [setTimeout, setInterval, setImmediate]) {
    const d = Object.getOwnPropertyDescriptor(fn, custom)!;
    let strict = "no throw";
    try {
      new Function("fn", "sym", '"use strict"; fn[sym] = 1;')(fn, custom);
    } catch (error) {
      strict = (error as Error).constructor.name;
    }
    console.log(fn.name, typeof d.get, typeof d.set, d.enumerable, d.configurable, strict);
  }
  console.log(
    "same as timers/promises",
    promisify(setTimeout) === timersPromises.setTimeout,
    promisify(setInterval) === timersPromises.setInterval,
    promisify(setImmediate) === timersPromises.setImmediate,
  );
  console.log("promisified setTimeout", await promisify(setTimeout)(1, "value"));
  let runs = 0;
  for await (const value of (promisify(setInterval) as unknown as typeof timersPromises.setInterval)(1, "tick")) {
    if (++runs === 3) {
      console.log("promisified setInterval", runs, value);
      break;
    }
  }
}

async function abortResistsStopPropagation() {
  for (const [name, start] of [
    ["setTimeout", (signal: AbortSignal) => timersPromises.setTimeout(1000, "late", { signal })],
    ["setImmediate", (signal: AbortSignal) => timersPromises.setImmediate("late", { signal })],
  ] as const) {
    const controller = new AbortController();
    controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
    const promise = start(controller.signal);
    controller.abort();
    const result = await promise.then(
      value => `resolved ${value}`,
      (error: Error) => `rejected ${error.name}`,
    );
    console.log("abort", name, result);
  }
}

async function immediateExceptionDefersMicrotasks() {
  const order: string[] = [];
  const onUncaught = (err: Error) => { order.push(`uncaught:${err.message}`); };
  process.on("uncaughtException", onUncaught);
  await new Promise<void>(resolve => {
    setImmediate(() => {
      order.push("imm1");
      queueMicrotask(() => order.push("micro1"));
      throw new Error("boom");
    });
    setImmediate(() => {
      order.push("imm2");
      queueMicrotask(() => {
        order.push("micro2");
        resolve();
      });
    });
  });
  process.off("uncaughtException", onUncaught);
  console.log("immediate exception order", order.join(","));

  const cancelledOrder: string[] = [];
  const onCancelledErr = (err: Error) => { cancelledOrder.push(`err:${err.message}`); };
  process.on("uncaughtException", onCancelledErr);
  await new Promise<void>(resolve => {
    let second!: ReturnType<typeof setImmediate>;
    setImmediate(() => {
      cancelledOrder.push("imm1");
      queueMicrotask(() => cancelledOrder.push("micro"));
      setTimeout(() => {
        cancelledOrder.push("timer");
        resolve();
      }, 0);
      const due = performance.now() + 5;
      while (performance.now() < due);
      clearImmediate(second);
      throw new Error("boom");
    });
    second = setImmediate(() => { cancelledOrder.push("imm2"); });
  });
  process.off("uncaughtException", onCancelledErr);
  console.log("immediate cancelled remainder order", cancelledOrder.join(","));
}

function runInFreshImmediateTurn(first: () => void, second: () => void): Promise<void> {
  return new Promise<void>(resolve => {
    process.nextTick(() => {
      setImmediate(() => {
        setImmediate(first);
        setImmediate(() => {
          second();
          resolve();
        });
      });
    });
  });
}

async function runFiveAwaits(order: string[]) {
  await 0;
  await 0;
  await 0;
  await 0;
  await 0;
  order.push("awaits");
}

async function nextTickAfterFirstAwait(order: string[]) {
  await 0;
  process.nextTick(() => order.push("tick"));
  await 0;
  await 0;
  await 0;
  await 0;
  order.push("awaits");
}

async function nextTickMicrotaskOrdering() {
  const fromMicrotask: string[] = [];
  await runInFreshImmediateTurn(
    () => {
      Promise.resolve().then(() => {
        fromMicrotask.push("microtask");
        process.nextTick(() => fromMicrotask.push("tick"));
        Promise.resolve().then(() => fromMicrotask.push("microtask2"));
      });
    },
    () => fromMicrotask.push("next-immediate"),
  );
  console.log("nextTick from microtask", fromMicrotask.join(","));

  const fromCallback: string[] = [];
  await runInFreshImmediateTurn(
    () => {
      process.nextTick(() => fromCallback.push("tick"));
      Promise.resolve().then(() => fromCallback.push("microtask"));
    },
    () => fromCallback.push("next-immediate"),
  );
  console.log("nextTick from callback", fromCallback.join(","));

  const nativeAwaits: string[] = [];
  await runInFreshImmediateTurn(
    () => {
      Promise.resolve().then(() => {
        process.nextTick(() => nativeAwaits.push("tick"));
        void runFiveAwaits(nativeAwaits);
      });
    },
    () => nativeAwaits.push("next-immediate"),
  );
  console.log("nextTick with native awaits", nativeAwaits.join(","));

  const afterAwait: string[] = [];
  await runInFreshImmediateTurn(
    () => { void nextTickAfterFirstAwait(afterAwait); },
    () => afterAwait.push("next-immediate"),
  );
  console.log("nextTick after first await", afterAwait.join(","));

  const syncWithAwait: string[] = [];
  await runInFreshImmediateTurn(
    () => {
      void (async () => { await 0; syncWithAwait.push("await"); })();
      process.nextTick(() => syncWithAwait.push("tick"));
    },
    () => syncWithAwait.push("next-immediate"),
  );
  console.log("nextTick sync before await", syncWithAwait.join(","));

  const thrown: string[] = [];
  const onErr = (err: Error) => { thrown.push(err.message); };
  process.on("uncaughtException", onErr);
  await new Promise<void>(resolve => {
    process.nextTick(() => { throw new Error("tick-err"); });
    process.nextTick(() => { thrown.push("tick-after"); resolve(); });
  });
  process.off("uncaughtException", onErr);
  console.log("nextTick throwing continues", thrown.join(","));

  const hookTestPath = `${import.meta.dir}/before-each-immediate.test.ts`;
  try {
    writeFileSync(
      hookTestPath,
      `import { beforeEach, expect, test } from "bun:test";
const trace: string[] = [];
beforeEach(() => {
  trace.push("before");
  setImmediate(() => trace.push("immediate"));
});
test("body runs before beforeEach setImmediate", async () => {
  expect(trace).toEqual(["before"]);
  const order: string[] = [];
  process.nextTick(() => order.push("tick"));
  Promise.resolve().then(() => order.push("micro"));
  await new Promise(resolve => setImmediate(resolve));
  expect(order).toEqual(["tick", "micro"]);
});
`,
    );
    const child = Bun.spawnSync([process.execPath, "test", hookTestPath]);
    console.log("bun:test beforeEach immediate", child.exitCode === 0);
  } finally {
    rmSync(hookTestPath, { force: true });
  }
}

await destroyed();
await refresh();
await stringIds();
await idleStart();
await intervalWritesInCallback();
await dueTimersBeforeImmediates();
await promisified();
await abortResistsStopPropagation();
await immediateExceptionDefersMicrotasks();
await nextTickMicrotaskOrdering();
console.log("done");
