import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { RuntimeWorkerHost } from "waffle/browser/worker";
import type { BunExecutorHost, RunRequest } from "../src/bun-executor.js";

// Exercise the actual Bun worker entry without executing guest code in the test runner's realm.
// Waffle's bootstrap/authority behavior is covered separately; this isolates the entry's capture
// of the browser's receiver-sensitive methods before Bun installs guest globals.
const source = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(
  readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/^export type .*;\n/gm, ""),
);

test("Bun worker captures host messaging, events and native fetch before guest replacement", async () => {
  const messages: unknown[] = [], events: string[] = [];
  let captured!: RuntimeWorkerHost & BunExecutorHost;
  const scope = {
    crossOriginIsolated: true, location: { href: "https://fixture.test/worker.js" },
    postMessage(message: unknown) { expect(this).toBe(scope); messages.push(message); },
    addEventListener() { expect(this).toBe(scope); events.push("add"); },
    removeEventListener() { expect(this).toBe(scope); events.push("remove"); },
    fetch() { expect(this).toBe(scope); return Promise.resolve(new Response("native")); },
    onmessage: undefined as unknown as (event: { data: RunRequest }) => void,
  };
  const request = {} as RunRequest;
  runInNewContext(source, {
    self: scope,
    createBunExecutor(data: RunRequest, host: typeof captured) { expect(data).toBe(request); captured = host; return {}; },
    bootstrap(data: RunRequest, _executor: unknown, host: typeof captured) { expect(data).toBe(request); expect(host).toBe(captured); },
  });
  scope.onmessage({ data: request });
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
      if (Atomics.load(evidence, 0) === 1 && Atomics.notify(gate, 0) === 1) { notified = true; return; }
      wake = setTimeout(notify, 1);
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
