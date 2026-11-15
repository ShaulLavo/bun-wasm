import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { receive, retain, validAssociation } from "./storage-fs-observation";
import { storageObservationSource } from "./storage-fs-build";
import { browserBuildConfig } from "./browser-build";
import { discoverChecks } from "./test-checks";
import { needsRust } from "./ci-changes";
import { observeFilesystemEndpoint } from "./storage-fs-endpoint";
import { createFilesystemConnection } from "../web/node_modules/waffle/fs/protocol";
import { retainMetadata } from "./storage-fs-metadata";
import { hasEntryRequestTraffic } from "./storage-fs-control";
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
  const waffle = ["web", "sandbox"].flatMap(app => ["fs/client.ts", "fs/service.ts", "runtime.ts", "browser/shared-fs.ts"].map(file => `${app}/node_modules/waffle/${file}`));
  const consumers = ["web/src/main.ts", "sandbox/src/main.ts", "web/src/worker.ts", "web/src/preview1-worker.ts", "web/src/fs-worker.ts", "web/node_modules/bash-web/src/runtime/worker.ts", "sandbox/node_modules/bash-web/src/runtime/worker.ts"].concat(waffle);
  for (const file of consumers) {
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
  for (const path of ["scripts/storage-fs-build.ts", "scripts/storage-fs-endpoint.ts", "scripts/storage-fs-observation.ts", "scripts/storage-fs-metadata.ts"]) {
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

const nativeContext = { tree: "control", realm: "native-port", endpoint: "service", workerURL: "control" } satisfies Parameters<typeof observeFilesystemEndpoint>[1];

test("native ports retain more than 22 complete sends and receives at qualification and close", async () => {
  const pair = createFilesystemConnection();
  const emitted: ReturnType<ReturnType<typeof observeFilesystemEndpoint>["snapshot"]>[] = [];
  const sender = observeFilesystemEndpoint(pair.server, nativeContext, () => emitted.push(sender.snapshot()));
  const receiver = observeFilesystemEndpoint(pair.client, { ...nativeContext, endpoint: "client" });
  const done = Promise.withResolvers<void>();
  let received = 0;
  pair.client.port.onmessage = () => { if (++received === 30) done.resolve(); };
  pair.client.port.onmessageerror = () => { throw Error("unexpected native error"); };
  try {
    for (let index = 1; index <= 30; index++) pair.server.port.postMessage({ segment: index, buffer: new SharedArrayBuffer(16) });
    pair.server.port.onmessage = () => {};
    pair.server.port.onmessageerror = () => {};
    sender.qualifyHandlers();
    receiver.qualifyHandlers();
    await done.promise;
    expect(sender.snapshot().sends).toBe(30);
    expect(receiver.snapshot().receives).toBe(30);
    expect(sender.snapshot().history.filter(row => row.event === "send-call").map(row => row.frame && "index" in row.frame ? row.frame.index : null)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(sender.snapshot().history.filter(row => row.event === "send-return").every(row => row.result === "undefined")).toBe(true);
    expect(emitted.at(-1)?.history.length).toBe(60);
    const beforeClose = sender.snapshot();
    expect(pair.server.port.close()).toBeUndefined();
    expect(sender.snapshot().history.slice(-2).map(row => row.event)).toEqual(["close-call", "close-return"]);
    expect(beforeClose.history.length).toBe(60);
    expect(sender.snapshot().historyDropped).toBe(0);
    expect(receiver.snapshot().historyDropped).toBe(0);
    await Promise.resolve();
    expect(emitted.at(-1)?.history.at(-1)?.event).toBe("close-return");
  } finally { sender.dispose(); receiver.dispose(); pair.server.port.close(); pair.client.port.close(); }
});

test("injected error on a native port captures revocation before original handlers and stays immutable", () => {
  const pair = createFilesystemConnection();
  const observer = observeFilesystemEndpoint(pair.client, { ...nativeContext, endpoint: "client" });
  const revocation = new Int32Array(pair.client.revocations[0]!);
  const states = new Int32Array(pair.client.ownerStates);
  Atomics.store(revocation, 0, 1);
  Atomics.store(states, 0, 2);
  pair.client.port.onmessage = () => {};
  pair.client.port.onmessageerror = () => { Atomics.store(revocation, 0, 2); Atomics.store(states, 0, 3); };
  try {
    observer.qualifyHandlers();
    const event = new MessageEvent("messageerror");
    pair.client.port.dispatchEvent(event);
    expect(observer.snapshot().first).toMatchObject({ kind: "messageerror", closedBefore: null, identityRevocation: 1, serviceRevocation: 2, trusted: event.isTrusted });
    expect(observer.snapshot()).toMatchObject({ identityRevocation: 2, serviceRevocation: 3, closed: null });
    expect(Object.isFrozen(observer.snapshot().first)).toBe(true);
  } finally { observer.dispose(); pair.client.port.close(); pair.server.port.close(); }
});

test("unavailable authority words are never reported as zero and overflow keeps its exact drop count", () => {
  const pair = createFilesystemConnection();
  const observer = observeFilesystemEndpoint({ ...pair.server, revocations: [], ownerStates: new SharedArrayBuffer(0) }, nativeContext);
  try {
    for (let index = 1; index <= 80; index++) pair.server.port.postMessage({ segment: index, buffer: new SharedArrayBuffer(16) });
    const snapshot = observer.snapshot();
    expect(snapshot).toMatchObject({ identityRevocation: null, serviceRevocation: null, ownerState: null, sends: 80, historyLimit: 128, historyDropped: 32 });
    expect(snapshot.history.length).toBe(128);
    expect(snapshot.history.at(-1)?.sequence).toBe(128);
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(32768);
    expect(JSON.stringify(snapshot)).not.toMatch(/SharedArrayBuffer|Int32Array|MessagePort/);
  } finally { observer.dispose(); pair.client.port.close(); pair.server.port.close(); }
});

test("close preserves the original receiver, tuple, result and thrown identity even if reporting fails", async () => {
  const pair = createFilesystemConnection();
  const port = pair.server.port;
  const native = port.close;
  const failure = Error("close failure");
  const reportFailure = Error("close reporter failure");
  const reported: unknown[] = [];
  const result = {};
  const tuple = ["ignored native close argument", { original: true }];
  let fail = false;
  port.close = function (...args) {
    const actual: unknown = args;
    expect(this).toBe(port);
    expect(actual).toEqual(tuple);
    if (fail) throw failure;
    Reflect.apply(native, this, args);
    return result;
  };
  const observer = observeFilesystemEndpoint(pair.server, nativeContext, () => { throw reportFailure; }, error => reported.push(error));
  try {
    const call: unknown = port.close;
    if (typeof call !== "function") throw Error("missing original close hook");
    const returned: unknown = Reflect.apply(call, port, tuple);
    expect(returned).toBe(result);
    fail = true;
    try { Reflect.apply(call, port, tuple); throw Error("did not throw"); } catch (error) { expect(error).toBe(failure); }
    expect(observer.snapshot().history.map(row => row.event)).toEqual(["close-call", "close-return", "close-call", "close-error"]);
    expect(reported).toEqual([reportFailure, reportFailure]);
  } finally { observer.dispose(); port.close = native; port.close(); pair.client.port.close(); }
});

test("bounded metadata retains complete matched service history rather than first-send snapshots", () => {
  const rows: object[] = [];
  for (let sends = 1; sends <= 30; sends++) retainMetadata(rows, { ...own, snapshot: { owner: 16, generation: 16, endpoint: "service", sends, history: Array.from({ length: sends }, (_, index) => ({ event: "send-return", sequence: index + 1 })) } });
  retainMetadata(rows, { ...own, workerId: 24, snapshot: { owner: 16, generation: 16, endpoint: "client", first: { kind: "messageerror" } } });
  expect(rows.length).toBe(2);
  expect(rows[0]).toMatchObject({ snapshot: { sends: 30 } });
  expect(rows[0] && "snapshot" in rows[0] ? rows[0].snapshot : null).toMatchObject({ history: expect.arrayContaining([{ event: "send-return", sequence: 30 }]) });
  let dropped = 0;
  for (let owner = 100; owner <= 140; owner++) if (retainMetadata(rows, { ...own, snapshot: { owner, generation: owner, endpoint: "service" } })) dropped++;
  expect(rows.length).toBe(32);
  expect(dropped).toBe(11);
});

function withoutField(value: object, field: string): object {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function fixture(entry = "bun", count = 8) {
  const identity = { documentId: "original-document", runtimeId: "original-runtime" };
  const snapshot = { owner: 3, generation: 3, handlersQualified: true };
  const client = { ...identity, workerId: 4, process: { entry, executorBranch: "terminal" },
    snapshot: { ...snapshot, endpoint: "client", requestSends: count, requestReceives: 0 } };
  const service = { ...identity, workerId: 1, process: null,
    snapshot: { ...snapshot, endpoint: "service", requestSends: 0, requestReceives: count } };
  return { client, service, rows: [client, service] };
}

for (const entry of ["bun", "shell", "preview1"]) {
  for (const count of [1, 2, 8, 10]) {
    test(`${entry} accepts successful request count ${count} on the matching qualified pair`, () => {
      expect(hasEntryRequestTraffic(fixture(entry, count).rows, entry)).toBe(true);
    });
  }
}

for (const value of [0, -1, undefined, null, "1", NaN, Infinity, 1.5, true]) {
  test(`rejects invalid client or service request count ${String(value)}`, () => {
    const { client, service, rows } = fixture();
    Object.assign(client.snapshot, { requestSends: value });
    expect(hasEntryRequestTraffic(rows, "bun")).toBe(false);
    client.snapshot.requestSends = 8;
    Object.assign(service.snapshot, { requestReceives: value });
    expect(hasEntryRequestTraffic(rows, "bun")).toBe(false);
  });
}

test("missing request fields cannot qualify through generic sends or receives", () => {
  const { client, service } = fixture();
  const { requestSends: _sends, ...noSends } = client.snapshot;
  const { requestReceives: _receives, ...noReceives } = service.snapshot;
  expect(hasEntryRequestTraffic([{ ...client, snapshot: { ...noSends, sends: 10 } }, service], "bun")).toBe(false);
  expect(hasEntryRequestTraffic([client, { ...service, snapshot: { ...noReceives, receives: 10 } }], "bun")).toBe(false);
});

for (const field of ["documentId", "runtimeId", "owner", "generation"]) {
  test(`rejects a service with mismatched ${field} even beside a matching idle peer`, () => {
    const { client, service } = fixture();
    const wrong = { ...service, snapshot: { ...service.snapshot } };
    if (field === "documentId" || field === "runtimeId") wrong[field] = "other";
    else Object.assign(wrong.snapshot, { [field]: 99 });
    const idle = { ...service, snapshot: { ...service.snapshot, requestReceives: 0 } };
    expect(hasEntryRequestTraffic([client, idle, wrong], "bun")).toBe(false);
  });
}

test("traffic on another entry or unqualified client cannot qualify the selected client", () => {
  const { client, service } = fixture();
  const idle = { ...client, snapshot: { ...client.snapshot, requestSends: 0 } };
  const otherEntry = { ...client, process: { ...client.process, entry: "shell" } };
  const unqualified = { ...client, snapshot: { ...client.snapshot, handlersQualified: false } };
  expect(hasEntryRequestTraffic([idle, otherEntry, unqualified, service], "bun")).toBe(false);
});

test("traffic must belong to the same selected terminal Preview1 client", () => {
  const { client, service } = fixture("preview1");
  const terminal = { ...client, snapshot: { ...client.snapshot, requestSends: 0 } };
  const plain = { ...client, process: { ...client.process, executorBranch: "plain" } };
  expect(hasEntryRequestTraffic([terminal, plain, service], "preview1")).toBe(false);
  expect(hasEntryRequestTraffic([client, service], "preview1")).toBe(true);
});

test("client and service endpoints must each have their original handlers qualified", () => {
  const { client, service } = fixture();
  expect(hasEntryRequestTraffic([{ ...client, snapshot: { ...client.snapshot, handlersQualified: false } }, service], "bun")).toBe(false);
  expect(hasEntryRequestTraffic([client, { ...service, snapshot: { ...service.snapshot, handlersQualified: false } }], "bun")).toBe(false);
  expect(hasEntryRequestTraffic([{ ...client, snapshot: { ...client.snapshot, endpoint: "service" } }, service], "bun")).toBe(false);
  expect(hasEntryRequestTraffic([client, { ...service, snapshot: { ...service.snapshot, endpoint: "client" } }], "bun")).toBe(false);
});

test("missing or malformed peer identities do not match each other", () => {
  const { client, service } = fixture();
  for (const field of ["documentId", "runtimeId", "workerId"]) {
    expect(hasEntryRequestTraffic([withoutField(client, field), withoutField(service, field)], "bun")).toBe(false);
  }
  for (const field of ["owner", "generation"]) {
    expect(hasEntryRequestTraffic([{ ...client, snapshot: withoutField(client.snapshot, field) }, { ...service, snapshot: withoutField(service.snapshot, field) }], "bun")).toBe(false);
    expect(hasEntryRequestTraffic([{ ...client, snapshot: { ...client.snapshot, [field]: "3" } },
      { ...service, snapshot: { ...service.snapshot, [field]: "3" } }], "bun")).toBe(false);
  }
});
