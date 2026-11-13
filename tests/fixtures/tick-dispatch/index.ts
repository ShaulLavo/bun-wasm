import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<number>();

function turn(index: number): Promise<void> {
  return new Promise(resolve => {
    const events: string[] = [];
    let returned = false;
    const immediate = setImmediate(() => {
      assert(returned, "Immediate must be deferred");
      assert.equal(context.getStore(), index);
      process.nextTick(() => tick(events, index, resolve));
      Promise.resolve().then(() => events.push("promise"));
      process.nextTick(() => events.push("second tick"));
    });
    assert(immediate.hasRef());
    immediate.unref();
    assert(!immediate.hasRef());
    immediate.ref();
    returned = true;
  });
}

function tick(events: string[], index: number, resolve: () => void): void {
  assert.equal(context.getStore(), index);
  events.push("first tick");
  process.nextTick(() => events.push("nested tick"));
  Promise.resolve().then(() => {
    assert.equal(context.getStore(), index);
    events.push("promise from tick");
    process.nextTick(() => finish(events, index, resolve));
  });
}

function finish(events: string[], index: number, resolve: () => void): void {
  assert.equal(context.getStore(), index);
  assert.deepEqual(events, ["first tick", "second tick", "nested tick", "promise", "promise from tick"]);
  resolve();
}

for (let index = 0; index < 200; index++) await context.run(index, () => turn(index));
assert.equal(context.getStore(), undefined);
const cancelled = setImmediate(() => assert.fail("cancelled Immediate ran"));
clearImmediate(cancelled);
console.log("tick dispatch ok");
