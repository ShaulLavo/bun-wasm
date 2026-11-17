import { expect, test } from "bun:test";
import { runInContext } from "node:vm";
import { eventTargetSource } from "./event-target-source";

test("private observation authenticates brands and owns exactly one disposable subscription", () => {
  const { context } = eventTargetSource();
  runInContext(`
    const target = new EventTarget(), calls = [], observe = internal.eventTargets.observe;
    let traps = 0;
    for (const bad of [{}, new Proxy(target, { get() { traps++; throw 1; } })]) {
      let rejected = false;
      try { observe(bad, () => {}); } catch { rejected = true; }
      if (!rejected) throw new Error('brand');
    }
    if (traps) throw new Error('proxy probed');
    try { observe(target, {}); throw 1; } catch (error) { if (error === 1) throw error; }
    const callback = type => calls.push(type);
    Object.defineProperties(callback, { call: { get() { throw 2; } }, apply: { get() { throw 3; } } });
    const old = observe(target, callback);
    if (calls.length) throw new Error('initial notification');
    try { observe(target, () => {}); throw 4; } catch (error) { if (error === 4) throw error; }
    target.addEventListener('one', () => {});
    old(); old();
    const replacement = observe(target, callback);
    old();
    target.addEventListener('two', () => {});
    replacement();
    target.addEventListener('three', () => {});
    if (calls.join(',') !== 'one,two') throw new Error('subscription ownership');
  `, context);
});

test("post-commit notifications expose exact live membership and nested observer replacement", () => {
  const { context } = eventTargetSource();
  runInContext(`
    const target = new EventTarget(), rows = [], api = internal.eventTargets;
    const listener = () => {}, controller = new AbortController();
    let dispose = api.observe(target, type => {
      rows.push([type, api.count(target, type), api.listeners(target, type).includes(listener)]);
      if (rows.length !== 1) return;
      dispose();
      api.observe(target, type => rows.push([type, api.count(target, type), api.listeners(target, type).includes(listener)]));
      target.removeEventListener(type, listener);
    });
    target.addEventListener('x', listener, { signal: controller.signal });
    controller.abort();
    target.removeEventListener('x', listener);
    target.addEventListener('x', listener);
    target.addEventListener('x', listener);
    target.addEventListener('x', listener, true);
    target.removeEventListener('x', listener, true);
    target.addEventListener('x', () => {}, { signal: AbortSignal.abort() });
    if (JSON.stringify(rows) !== JSON.stringify([['x',1,true],['x',0,false],['x',1,true],['x',2,true],['x',1,true]])) throw new Error(JSON.stringify(rows));
    target.removeEventListener('x', listener);
  `, context);
});

test("attribute notification commits the slot before reentry and once notifies before invocation", () => {
  const { context } = eventTargetSource();
  runInContext(`
    const signal = new AbortController().signal, api = internal.eventTargets, rows = [];
    const first = () => {}, second = {};
    api.observe(signal, type => {
      const snapshot = api.listeners(signal, type);
      if (snapshot.length !== api.count(signal, type) || (snapshot[0] || null) !== signal.onabort) throw new Error('uncommitted slot');
      rows.push(signal.onabort);
      if (signal.onabort === first) signal.onabort = second;
    });
    signal.onabort = first;
    signal.onabort = second;
    signal.onabort = null;
    if (rows.length !== 3 || rows[0] !== first || rows[1] !== second || rows[2] !== null) throw new Error('attribute notifications');
    const target = new EventTarget(), order = [];
    api.observe(target, type => order.push(api.count(target, type)));
    target.addEventListener('x', () => order.push(api.count(target, 'x')), { once: true });
    target.dispatchEvent(new Event('x'));
    if (order.join(',') !== '1,0,0') throw new Error('once notification');
  `, context);
});

test("observer errors preserve original values and cannot suppress protected abort or hidden cleanup", () => {
  const { context, ticks } = eventTargetSource();
  const sentinel = {};
  Object.assign(context, { sentinel });
  runInContext(`
    const api = internal.eventTargets, controller = new AbortController(), target = new EventTarget();
    const listener = () => {}, calls = [];
    target.addEventListener('x', listener, { signal: controller.signal });
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
    api.observe(target, () => { throw sentinel; });
    const hook = () => calls.push(api.count(target, 'x'));
    api.addAbortListener(controller.signal, hook);
    api.addAbortListener(controller.signal, hook);
    controller.abort();
    if (calls.join(',') !== '0') throw new Error('abort cleanup blocked');
  `, context);
  expect(ticks).toHaveLength(1);
  const tick = ticks[0];
  if (!tick) throw new Error("missing observer error tick");
  let thrown: unknown;
  try { tick(); } catch (error) { thrown = error; }
  expect(thrown).toBe(sentinel);
});

test("protected duplicate domains notify only canonical insertion and exact removal", () => {
  const { context } = eventTargetSource();
  runInContext(`
    const api = internal.eventTargets;
    for (const protectedFirst of [false, true]) {
      const signal = new AbortController().signal, counts = [], listener = () => {};
      api.observe(signal, type => counts.push(api.count(signal, type)));
      if (protectedFirst) api.addAbortListener(signal, listener);
      else signal.addEventListener('abort', listener);
      api.addAbortListener(signal, listener);
      signal.addEventListener('abort', listener);
      signal.addEventListener('abort', listener, true);
      signal.removeEventListener('abort', listener);
      signal.removeEventListener('abort', listener);
      signal.removeEventListener('abort', listener, true);
      if (counts.join(',') !== '1,2,1,0') throw new Error('duplicate publication ' + counts);
    }
  `, context);
});
