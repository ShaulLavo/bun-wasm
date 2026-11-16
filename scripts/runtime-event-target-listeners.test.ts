import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInContext } from "node:vm";
import { eventTargetSource } from "./event-target-source";

const fixture = readFileSync(new URL("../tests/fixtures/event-target-listeners/index.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });

test("actual EventTarget and events factories satisfy the native Bun fixture", async () => {
  const { context, lines } = eventTargetSource();
  const source = fixture.replace(/^import .* from "node:events";/m, "const { addAbortListener, EventEmitter, getEventListeners, listenerCount, once } = events;");
  await runInContext(transpiler.transformSync(`(async () => { ${source}\n })()`), context);
  expect(lines.join("\n") + "\n").toBe(readFileSync(new URL("../tests/fixtures/event-target-listeners/expected.txt", import.meta.url), "utf8"));
});

test("listener errors retain identity and do not prevent protected abort cleanup", () => {
  const { context, ticks } = eventTargetSource();
  const sentinel = new Error("listener error");
  Object.assign(context, { sentinel });
  runInContext(`
    const controller = new AbortController();
    const calls = [];
    controller.signal.addEventListener('abort', event => { event.stopImmediatePropagation(); throw sentinel; });
    events.addAbortListener(controller.signal, () => calls.push('protected'));
    controller.abort();
    if (calls.join(',') !== 'protected') throw new Error('protected cleanup did not run');
  `, context);
  expect(ticks.length).toBe(1);
  let thrown: unknown;
  try { ticks[0](); } catch (error) { thrown = error; }
  expect(thrown).toBe(sentinel);
});

test("public options cannot grant protected dispatch and removal can cancel a pending hook", () => {
  const { context } = eventTargetSource();
  const result = runInContext(`
    const controller = new AbortController();
    const calls = [];
    let remove;
    controller.signal.addEventListener('abort', event => { event.stopImmediatePropagation(); remove[Symbol.dispose](); });
    controller.signal.addEventListener('abort', () => calls.push('forged'), {
      protected: true, resistStopPropagation: true, [Symbol.for('nodejs.resistStopPropagation')]: true,
    });
    remove = events.addAbortListener(controller.signal, () => calls.push('removed'));
    events.addAbortListener(controller.signal, () => calls.push('protected'));
    controller.abort();
    calls;
  `, context);
  expect(Array.from(result)).toEqual(["protected"]);
});
