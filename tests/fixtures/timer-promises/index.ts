import assert from "node:assert/strict";
import { setTimeout as delay, setImmediate as immediate, setInterval as interval } from "node:timers/promises";

function tracked() {
  const controller = new AbortController();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const wrappers = new Map<EventListenerOrEventListenerObject, EventListener>();
  function once(listener: EventListenerOrEventListenerObject): EventListener {
    return event => {
      listeners.delete(listener);
      wrappers.delete(listener);
      if (typeof listener === "function") listener.call(signal, event);
      else listener.handleEvent(event);
    };
  }
  signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (!listener) return;
    if (type !== "abort") { add(type, listener, options); return; }
    listeners.add(listener);
    if (typeof options !== "object" || !options.once) { add(type, listener, options); return; }
    const wrapper = once(listener);
    wrappers.set(listener, wrapper);
    add(type, wrapper, options);
  };
  signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    if (!listener) return;
    if (type !== "abort") { remove(type, listener, options); return; }
    listeners.delete(listener);
    remove(type, wrappers.get(listener) ?? listener, options);
    wrappers.delete(listener);
  };
  return { controller, signal, listeners };
}

const shared = tracked();
try {
  for (let index = 0; index < 7; index++) {
    assert.equal(await delay(1, index, { signal: shared.signal }), index);
    assert.equal(shared.listeners.size, 0);
    assert.equal(await immediate(index, { signal: shared.signal }), index);
    assert.equal(shared.listeners.size, 0);
  }
} finally { shared.controller.abort(); }
console.log("timeout and immediate success release listeners");

function aborted(reason: unknown) { return { name: "AbortError", code: "ABORT_ERR", cause: reason }; }
async function closed(iterator: AsyncIterableIterator<string>, reason: unknown) {
  await iterator.next().then(result => assert.equal(result.done, true), error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.cause, reason);
  });
}

async function checkAbort(kind: "timeout" | "immediate" | "interval", preaborted: boolean) {
  const state = tracked();
  if (preaborted) state.controller.abort("early");
  let iterator: AsyncIterableIterator<string> | undefined;
  try {
    if (kind === "interval") iterator = interval(10, "tick", { signal: state.signal });
    const pending = iterator ? iterator.next() : kind === "timeout" ? delay(10, "tick", { signal: state.signal }) : immediate("tick", { signal: state.signal });
    const check = assert.rejects(pending, aborted(preaborted ? "early" : "later"));
    if (!preaborted) state.controller.abort("later");
    await check;
    assert.equal(state.listeners.size, 0);
    if (iterator) await closed(iterator, preaborted ? "early" : "later");
  } finally {
    state.controller.abort();
    await iterator?.return?.();
  }
}
for (const kind of ["timeout", "immediate", "interval"] as const) {
  await checkAbort(kind, true);
  await checkAbort(kind, false);
}
console.log("pre-aborted and pending waits reject with cause and release listeners");

const state = tracked();
const iterator = interval(1, "tick", { signal: state.signal });
try {
  const first = await iterator.next();
  assert.equal(first.value, "tick");
  assert.equal(first.done, false);
  state.controller.abort("between");
  await assert.rejects(iterator.next(), aborted("between"));
  await closed(iterator, "between");
  assert.equal(state.listeners.size, 0);
} finally { state.controller.abort(); await iterator.return?.(); }
console.log("abort between interval ticks prevents more values");

const breaking = tracked();
try {
  const values: string[] = [];
  for await (const value of interval(1, "tick", { signal: breaking.signal })) { values.push(value); break; }
  assert.deepEqual(values, ["tick"]);
  assert.equal(breaking.listeners.size, 0);
} finally { breaking.controller.abort(); }
console.log("for-await break releases the interval listener");

const returning = tracked();
const returned = interval(1, "tick", { signal: returning.signal });
try {
  assert.equal((await returned.next()).done, false);
  const close = returned.return;
  assert.ok(close);
  assert.notEqual((await close.call(returned)).value, "tick");
  assert.equal(returning.listeners.size, 0);
} finally { returning.controller.abort(); await returned.return?.(); }
console.log("iterator return releases the interval listener");
