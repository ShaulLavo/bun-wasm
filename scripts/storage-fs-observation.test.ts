import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { receive, retain, validAssociation } from "./storage-fs-observation";
import { storageObservationSource } from "./storage-fs-build";
import { browserBuildConfig } from "./browser-build";
import { discoverChecks } from "./test-checks";
import { needsRust } from "./ci-changes";
const own = { documentId: crypto.randomUUID(), runtimeId: crypto.randomUUID(), workerId: 1, pageURL: "http://localhost/" };

test("observation rejects missing and cross-document/runtime/Worker identities", () => {
  const row = { ...own, snapshot: { owner: 1, generation: 1 } };
  const output: object[] = [];
  receive({ ...own, row }, own, row => output.push(row));
  expect(output).toEqual([row]);
  for (const invalid of [null, {}, { ...own, documentId: undefined }, { ...own, runtimeId: undefined }, { ...own, workerId: 0 }, { ...own, workerId: 2 }, { ...own, documentId: crypto.randomUUID() }, { ...own, runtimeId: crypto.randomUUID() }, { ...own, pageURL: "http://other/" }]) {
    expect(() => receive({ ...invalid, row }, own, () => {})).toThrow();
  }
  expect(validAssociation({ ...own, workerId: Number.NaN })).toBe(false);
  expect(() => receive({ ...own, row: {} }, own, () => {})).toThrow();
  expect(() => receive({ ...own, row: { ...row, runtimeId: crypto.randomUUID() } }, own, () => {})).toThrow();
});
test("retention bounds recent metadata and separates stale shared closure from a local event", () => {
  const state = { recent: [], causalEvents: 0, propagationEvents: 0, causalKeys: new Set<string>() }, emitted: object[] = [];
  for (let i = 0; i < 100; i++) retain({ snapshot: { first: { kind: i % 2 ? "shared-closed" : "transportClosed", closedBefore: i % 2 ? "stale" : "messageerror" } }, i }, state, row => emitted.push(row));
  expect(state.recent.length).toBe(32);
  expect(emitted).toEqual([]);
  retain({ snapshot: { first: { kind: "messageerror", trusted: false, closedBefore: null } } }, state, row => emitted.push(row));
  expect(emitted.length).toBe(1);
  expect(JSON.stringify(emitted)).toContain('"initiatingCauseProved":false');
});
test("all actual consumer seams fail closed on source drift and leave executors untouched", () => {
  for (const file of ["web/src/main.ts", "web/src/worker.ts", "web/src/preview1-worker.ts", "web/src/fs-worker.ts", "web/node_modules/bash-web/src/runtime/worker.ts", "web/node_modules/waffle/fs/client.ts", "web/node_modules/waffle/fs/service.ts", "web/node_modules/waffle/runtime.ts", "web/node_modules/waffle/browser/shared-fs.ts"]) {
    const path = resolve(import.meta.dir, "..", file), original = readFileSync(path, "utf8");
    const transformed = storageObservationSource(path, original);
    expect(transformed).toBeDefined();
    if (file.endsWith("/client.ts") || file.endsWith("/service.ts") || file.endsWith("/worker.ts") || file.endsWith("/preview1-worker.ts")) {
      expect(() => storageObservationSource(path, "source drift")).toThrow();
    }
    if (file === "web/src/worker.ts") expect(transformed).toContain("await bootstrap(request, executor, host);");
    if (file === "web/src/preview1-worker.ts") expect(transformed).toContain("await bootstrap(request, executor);");
  }
});
test("default build has no observation plugin and helper-only edits select the same blocking storage gate", () => {
  const previous = process.env.BUN_WASM_STORAGE_DIAGNOSTICS;
  delete process.env.BUN_WASM_STORAGE_DIAGNOSTICS;
  try { expect(browserBuildConfig([resolve(import.meta.dir, "../web/src/main.ts")], "/work/tmp/unused").plugins?.some(plugin => plugin.name === "storage-first-event")).toBe(false); }
  finally { if (previous === undefined) delete process.env.BUN_WASM_STORAGE_DIAGNOSTICS; else process.env.BUN_WASM_STORAGE_DIAGNOSTICS = previous; }
  const storage = discoverChecks().find(check => check.path === "scripts/sandbox-storage-browser.test.ts");
  for (const path of ["scripts/storage-fs-build.ts", "scripts/storage-fs-endpoint.ts", "scripts/storage-fs-observation.ts"]) {
    expect(storage?.inputs).toContain(path);
    expect(needsRust([path])).toBe(true);
  }
});

test("native post result, receiver, exact tuple and thrown identity survive metadata observation", async () => {
  const { createFilesystemConnection } = await import("../web/node_modules/waffle/fs/protocol");
  const { observeFilesystemEndpoint } = await import("./storage-fs-endpoint");
  const pair = createFilesystemConnection();
  const port = pair.client.port;
  const original = port.postMessage;
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  const result = {};
  const failure = new Error("original native failure");
  let fail = false;
  port.postMessage = function (...args) { calls.push({ receiver: this, args }); if (fail) throw failure; return result; };
  const observer = observeFilesystemEndpoint(pair.client, { tree: "control", realm: "native-port", endpoint: "client", workerURL: "control" });
  const payload = new Uint8Array([17, 19, 23]).buffer;
  const frame = { id: 1, generation: pair.client.requests.generation, payload };
  const transfers = [payload];
  try {
    expect(Reflect.apply(port.postMessage, port, [frame, transfers])).toBe(result);
    expect(calls[0]?.receiver).toBe(port);
    expect(calls[0]?.args[0]).toBe(frame);
    expect(calls[0]?.args[1]).toBe(transfers);
    fail = true;
    expect(() => port.postMessage(frame)).toThrow(failure);
    expect(observer.snapshot().first?.kind).toBe("send-error");
    expect(JSON.stringify(observer.snapshot())).not.toContain("17,19,23");
  } finally { observer.dispose(); port.postMessage = original; pair.client.port.close(); pair.server.port.close(); }
});

test("propagation cannot consume the causal quota and overflow is explicit and bounded", () => {
  const state = { recent: [], causalEvents: 0, propagationEvents: 0, causalKeys: new Set<string>() }, emitted: object[] = [];
  for (let i = 0; i < 100; i++) retain({ snapshot: { first: { kind: "shared-closed", closedBefore: "messageerror" } } }, state, row => emitted.push(row));
  for (let i = 0; i < 100; i++) retain({ snapshot: { first: { kind: i % 2 ? "messageerror" : "send-error", closedBefore: null, sequence: i } }, i }, state, row => emitted.push(row));
  expect(state.causalEvents).toBe(17);
  expect(state.causalKeys.size).toBe(17);
  expect(state.propagationEvents).toBe(100);
  expect(state.recent.length).toBe(32);
  expect(emitted.length).toBe(17);
  expect(emitted[16]).toMatchObject({ kind: "causal-overflow", truncated: true, causalEventsAtLeast: 17, droppedAtLeast: 1 });
});

test("observation callback failure cannot replace the original native result or error", async () => {
  const { createFilesystemConnection } = await import("../web/node_modules/waffle/fs/protocol");
  const { observeFilesystemEndpoint } = await import("./storage-fs-endpoint");
  const pair = createFilesystemConnection();
  const original = pair.client.port.postMessage;
  const nativeError = new Error("native error");
  const metadataError = new Error("metadata sink error");
  const reported: unknown[] = [];
  let fail = false;
  pair.client.port.postMessage = () => { if (fail) throw nativeError; return 41; };
  const observer = observeFilesystemEndpoint(pair.client, { tree: "control", realm: "native-port", endpoint: "client", workerURL: "control" }, () => { throw metadataError; }, error => reported.push(error));
  try {
    const returned: unknown = Reflect.apply(pair.client.port.postMessage, pair.client.port, [{}]);
    expect(returned).toBe(41);
    fail = true;
    try { pair.client.port.postMessage({}); throw Error("did not throw"); } catch (error) { expect(error).toBe(nativeError); }
    expect(reported).toEqual([metadataError, metadataError]);
  } finally { observer.dispose(); pair.client.port.postMessage = original; pair.client.port.close(); pair.server.port.close(); }
});

test.each([false, true])("frame inspection failure preserves the native send when reporting throws=%s", async reportThrows => {
  const { createFilesystemConnection } = await import("../web/node_modules/waffle/fs/protocol");
  const { observeFilesystemEndpoint } = await import("./storage-fs-endpoint");
  const pair = createFilesystemConnection();
  const port = pair.client.port;
  const original = port.postMessage;
  const metadataError = new Error("frame metadata inspection failed");
  const reporterError = new Error("metadata reporter failed");
  const reported: unknown[] = [];
  const frame = new Proxy({}, { has() { throw metadataError; } });
  let nativeError: unknown;
  let nativeCalls = 0;
  port.postMessage = function (...args) {
    nativeCalls++;
    expect(this).toBe(port);
    expect(args[0]).toBe(frame);
    try { return Reflect.apply(original, this, args); }
    catch (error) { nativeError = error; throw error; }
  };
  const observer = observeFilesystemEndpoint(pair.client, { tree: "control", realm: "native-port", endpoint: "client", workerURL: "control" }, () => {}, error => {
    reported.push(error);
    if (reportThrows) throw reporterError;
  });
  try {
    let observedError: unknown;
    try { port.postMessage(frame); } catch (error) { observedError = error; }
    expect(nativeCalls).toBe(1);
    expect(nativeError).toMatchObject({ name: "DataCloneError" });
    expect(observedError).toBe(nativeError);
    expect(observedError).not.toBe(metadataError);
    expect(observedError).not.toBe(reporterError);
    expect(reported).toEqual([metadataError]);
    expect(observer.snapshot().first?.kind).toBe("send-error");
  } finally { observer.dispose(); port.postMessage = original; port.close(); pair.server.port.close(); }
});

test("repeated causal snapshots cannot spend another emission or cross document streams", () => {
  const state = { recent: [], causalEvents: 0, propagationEvents: 0, causalKeys: new Set<string>() }, emitted: object[] = [];
  const snapshot = { owner: 1, generation: 1, endpoint: "client", first: { kind: "messageerror", closedBefore: null, sequence: 1 } };
  for (let i = 0; i < 100; i++) retain({ ...own, snapshot }, state, row => emitted.push(row));
  expect(emitted.length).toBe(1);
  retain({ ...own, documentId: crypto.randomUUID(), snapshot }, state, row => emitted.push(row));
  expect(emitted.length).toBe(2);
});
