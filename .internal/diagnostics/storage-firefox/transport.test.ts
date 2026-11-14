import { expect, test } from "bun:test";
import { association, belongs, handshake, workerTransport } from "./worker-transport.ts";
import { forwardPost } from "./post.ts";

test("dedicated Worker metadata forwards every ordinary message and intercepts only its handshake", async () => {
  const scope = new EventTarget();
  Object.assign(scope, { location: { href: "https://example.test/sandbox/worker.js" }, crossOriginIsolated: true });
  const transport = workerTransport(scope as DedicatedWorkerGlobalScope);
  const received: unknown[] = [];
  scope.addEventListener("message", event => received.push((event as MessageEvent).data));
  const original = { filesystem: { original: true } };
  scope.dispatchEvent(new MessageEvent("message", { data: original }));
  const pair = new MessageChannel();
  const own = { runtimeId: "00000000-0000-4000-8000-000000000001", workerId: 1 };
  const armed = new Promise(resolve => { pair.port1.onmessage = event => resolve(event.data); });
  scope.dispatchEvent(new MessageEvent("message", { data: { diagnostic: handshake, ...own }, ports: [pair.port2] }));
  expect(received).toEqual([original]);
  expect(await armed).toMatchObject({ ...own, payload: { kind: "transport-armed", workerIsolated: true } });
  const originalAfter = { connect: "unchanged" };
  scope.dispatchEvent(new MessageEvent("message", { data: originalAfter }));
  expect(received[1]).toBe(originalAfter);
  const controls: unknown[] = [];
  transport.addEventListener("message", event => controls.push(event.data));
  const rejected = new Promise(resolve => { pair.port1.onmessage = event => resolve(event.data); });
  pair.port1.postMessage({ runtimeId: "00000000-0000-4000-8000-000000000002", workerId: 1, payload: { command: "fault-service" } });
  expect(await rejected).toMatchObject({ ...own, payload: { kind: "control-rejected" } });
  expect(controls).toEqual([]);
  pair.port1.close(); pair.port2.close();
});
test("missing and overlapping foreign associations cannot address another runtime", () => {
  const own = { runtimeId: "00000000-0000-4000-8000-000000000001", workerId: 1 };
  expect(association(own)).toBe(true);
  for (const value of [{ workerId: 1 }, { runtimeId: own.runtimeId }, { ...own, workerId: 0 }, { ...own, runtimeId: "00000000-0000-4000-8000-000000000002" }]) expect(belongs(value, own)).toBe(false);
});
test("page Worker wrapper preserves constructor options, native receiver and original request tuple", async () => {
  const source = await Bun.file(new URL("collector.ts", import.meta.url)).text();
  const start = source.indexOf("globalThis.Worker = class");
  const wrapper = source.slice(start, source.indexOf("\nfunction snapshot()", start)).replace("globalThis.Worker =", "const ObservedWorker =");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(wrapper);
  const calls: unknown[][] = [];
  class NativeWorker {
    constructor(...args: unknown[]) { calls.push(args); }
    addEventListener() {}
    postMessage(...args: unknown[]) { calls.push([this].concat(args)); return "original-result"; }
  }
  const make = new Function("NativeWorker", "nativePost", "location", "attachTransport", "record", "postedIdentity", "forwardPost",
    `let nextWorkerId=0; const capture="00000000-0000-4000-8000-000000000001"; const workerURLs=[]; ${compiled}; return ObservedWorker;`);
  const Observed = make(NativeWorker, NativeWorker.prototype.postMessage, { href: "https://example.test/sandbox/" }, () => {}, () => {}, () => ({}), forwardPost);
  const url = new URL("https://example.test/sandbox/__bunwasm/worker.js"), options = { type: "module" };
  const worker = new Observed(url, options);
  expect(calls[0]?.[0]).toBe(url); expect(calls[0]?.[1]).toBe(options);
  const env = {}, message = { env, args: ["/bin/bun", "install"] }, transfer: unknown[] = [];
  expect(worker.postMessage(message, transfer)).toBe("original-result");
  expect(calls[1]?.[0]).toBe(worker); expect(calls[1]?.[1]).toBe(message); expect(calls[1]?.[2]).toBe(transfer);
  expect(message.env).toBe(env); expect(env).toEqual({});
});
