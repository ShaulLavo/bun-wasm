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

test.todo("same-realm Atomics and shared-view tampering cannot observe or override another process: pending Waffle intrinsic-capture fix; dynamic global Atomics currently exposes host views");
