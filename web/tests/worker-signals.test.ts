import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { RuntimeWorkerHost } from "waffle/browser/worker";
import type { BunExecutorHost, RunRequest } from "../src/bun-executor.js";
import { earlyInstance, type EarlyInstance } from "../src/early-instance.js";

// Exercise the actual Bun worker entry and bootstrap module without executing guest code in the
// test runner's realm. Waffle's bootstrap/authority behavior is covered separately; this isolates
// the capture of the browser's receiver-sensitive methods before Bun installs guest globals.
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const script = (file: string) => transpiler.transformSync(
  readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export type .*;\n/gm, "").replace(/^export function/gm, "function"),
);
const source = script("../src/worker-main.ts") + "\nstart(self, [], () => {});\n";
const entry = script("../src/worker.ts").replace('import("./worker-main.js")', "loadMain()");

test("Bun worker entry posts first, instantiates the guest on its start message, then loads its bootstrap", async () => {
  const messages: unknown[] = [];
  const listeners = new Set<(event: { data: unknown }) => void>();
  const loaded = Promise.withResolvers<{ start(ctx: unknown, early: readonly { data: unknown }[], stopKeeping: () => void, instance: EarlyInstance | undefined): void }>();
  const scope = {
    postMessage(message: unknown) { messages.push(message); },
    addEventListener(_type: string, listener: (event: { data: unknown }) => void) { listeners.add(listener); },
    removeEventListener(_type: string, listener: (event: { data: unknown }) => void) { listeners.delete(listener); },
  };
  const created: EarlyInstance[] = [];
  const instantiate = (request: unknown) => {
    // The guest is instantiated before the bootstrap starts to load.
    expect(loads).toBe(0);
    const instance = earlyInstance(request);
    if (instance) created.push(instance);
    return instance;
  };
  let loads = 0;
  runInNewContext(entry, { self: scope, setTimeout, earlyInstance: instantiate, loadMain() { loads++; expect(messages).toEqual([{ type: "worker-script" }]); return loaded.promise; } });
  expect(messages).toEqual([{ type: "worker-script" }]);
  // Nothing loads until the start message has been handled.
  expect(loads).toBe(0);
  expect(listeners.size).toBe(1);
  const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const request = { data: { module, startless: true } }, later = { data: { diagnostic: true } };
  for (const listener of listeners) { listener(request); listener(later); }
  expect(loads).toBe(1);
  expect(created.map(instance => instance.module)).toEqual([module]);
  const started = Promise.withResolvers<{ early: unknown[]; instance: EarlyInstance | undefined }>();
  loaded.resolve({ start(ctx, early, stopKeeping, instance) { expect(ctx).toBe(scope); stopKeeping(); started.resolve({ early: early.slice(), instance }); } });
  const handed = await started.promise;
  expect(handed.early).toEqual([request, later]);
  expect(handed.instance).toBe(created[0]);
  expect(listeners.size).toBe(0);
});

test("a first message that is not a startless guest still loads the bootstrap, with no early instance", async () => {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const loaded = Promise.withResolvers<{ start(ctx: unknown, early: readonly { data: unknown }[], stopKeeping: () => void, instance: EarlyInstance | undefined): void }>();
  const scope = { postMessage() {}, addEventListener(_type: string, listener: (event: { data: unknown }) => void) { listeners.add(listener); }, removeEventListener() {} };
  let loads = 0;
  runInNewContext(entry, { self: scope, setTimeout, earlyInstance, loadMain() { loads++; return loaded.promise; } });
  const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
  for (const listener of listeners) listener({ data: { module } });
  expect(loads).toBe(1);
  const started = Promise.withResolvers<EarlyInstance | undefined>();
  loaded.resolve({ start(_ctx, _early, _stopKeeping, instance) { started.resolve(instance); } });
  expect(await started.promise).toBeUndefined();
});

test("Bun worker bootstrap dispatches kept messages again after installing its handler", () => {
  const events: unknown[] = [];
  let stopped = 0;
  const scope = {
    crossOriginIsolated: true, location: { href: "https://fixture.test/worker.js" },
    postMessage() {}, addEventListener() {}, removeEventListener() {}, fetch() { return Promise.resolve(new Response()); },
    onmessage: undefined as unknown,
    dispatchEvent(event: { data: unknown; ports: readonly unknown[] }) { events.push({ data: event.data, handler: typeof scope.onmessage, ports: event.ports.length }); return true; },
  };
  const kept = [{ data: { diagnostic: true }, ports: [] }, { data: { start: true }, ports: [] }];
  runInNewContext(script("../src/worker-main.ts") + "\nstart(self, kept, stop);\n", {
    self: scope, kept, stop() { expect(scope.onmessage).toBeUndefined(); stopped++; },
    MessageEvent: class { readonly data: unknown; readonly ports: readonly unknown[]; constructor(_type: string, init: { data: unknown; ports: unknown[] }) { this.data = init.data; this.ports = init.ports; } },
  });
  expect(stopped).toBe(1);
  expect(events).toEqual([{ data: { diagnostic: true }, handler: "function", ports: 0 }, { data: { start: true }, handler: "function", ports: 0 }]);
});

test("Bun worker captures host messaging, events and native fetch before guest replacement", async () => {
  const messages: unknown[] = [], events: string[] = [];
  let captured!: RuntimeWorkerHost & BunExecutorHost;
  const scope = {
    crossOriginIsolated: true, location: { href: "https://fixture.test/worker.js" },
    postMessage(message: unknown) { expect(this).toBe(scope); messages.push(message); },
    addEventListener() { expect(this).toBe(scope); events.push("add"); },
    removeEventListener() { expect(this).toBe(scope); events.push("remove"); },
    fetch() { expect(this).toBe(scope); return Promise.resolve(new Response("native")); },
    onmessage: undefined as unknown as (event: { data: RunRequest }) => Promise<void>,
  };
  const request = {} as RunRequest;
  runInNewContext(source, {
    self: scope,
    hasTerminalMetadata: () => false,
    createBunExecutor(data: RunRequest, host: typeof captured) { expect(data).toBe(request); captured = host; return {}; },
    bootstrap(data: RunRequest, _executor: unknown, host: typeof captured) { expect(data).toBe(request); expect(host).toBe(captured); },
  });
  await scope.onmessage({ data: request });
  const replaced = () => { throw new Error("guest replacement was called"); };
  Object.assign(scope, { postMessage: replaced, fetch: replaced, addEventListener: replaced, removeEventListener: replaced });
  captured.postMessage({ type: "exit", code: 0 });
  const listener = () => {};
  captured.addEventListener!("error", listener); captured.removeEventListener!("error", listener);
  expect(await (await captured.fetch("https://fixture.test/")).text()).toBe("native");
  expect(messages).toEqual([{ type: "exit", code: 0 }]);
  expect(events).toEqual(["add", "remove"]);
  expect(Object.isFrozen(captured)).toBe(true);
});

test("same-realm Atomics and shared-view replacement cannot intercept worker signals or native waits", async () => {
  const evidence = new Int32Array(new SharedArrayBuffer(4));
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let worker: Worker | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let wake: ReturnType<typeof setTimeout> | undefined;
  let notified = false;
  try {
    const result = Promise.withResolvers<unknown>();
    deadline = setTimeout(() => result.reject(new Error("intrinsic-capture worker deadline exceeded")), 5_000);
    const notify = () => {
      // The worker may be scheduled away between publishing entry and waiting.
      // Retry notification, never change the word: success still requires waking
      // one actual native sleeper, not merely observing its intent to wait.
      notified = Atomics.load(evidence, 0) === 1 && Atomics.notify(gate, 0) === 1;
      if (!notified) wake = setTimeout(notify, 1);
    };
    worker = new Worker(new URL("./fixtures/worker-signals-intrinsics.ts", import.meta.url).href);
    worker.onerror = event => result.reject(new Error(event.message));
    worker.onmessage = event => {
      if (event.data.phase === "done") return result.resolve(event.data);
      wake = setTimeout(notify, 20);
    };
    worker.postMessage({ evidence: evidence.buffer, gate: gate.buffer });
    expect(await result.promise).toEqual({ phase: "done", waited: "ok", action: "handled", delivered: 2, requested: 2, intercepted: 0 });
    expect(notified).toBe(true);
  } finally {
    clearTimeout(deadline); clearTimeout(wake);
    await worker?.terminate();
  }
}, 10_000);
