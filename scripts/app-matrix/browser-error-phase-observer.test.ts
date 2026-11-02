import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { createRequire } from "module";
import { observeCall, replaceMethod, shadowMethod, type CallEvent } from "./fixtures/browser-error-phase-observer/server-observer-call";
import { exportPrelude, originalSourceSha256 } from "./fixtures/browser-error-phase-observer/load-components-descriptor";
import { getObserverState, observerSnapshot } from "./fixtures/browser-error-phase-observer/server-observer-state";
import { applyBrowserErrorPhaseObserver, observerHooks, requireServingObserver } from "./next-acceptance-observer";
import { fixtureSources, stageFixture } from "./next-acceptance-fixture";

const fixture = join(import.meta.dir, "../../examples/next-acceptance");
let speciesReads = 0;

function readSpecies(): typeof Promise {
  speciesReads++;
  return Promise;
}

function observeSpeciesPromise(promise: Promise<string>): Promise<string> {
  return observeCall(() => promise, () => {})();
}

test("observer stages only dedicated diagnostic files and the positive sender before compilation", () => {
  const source = fixtureSources(fixture);
  const original = JSON.stringify(source);
  const staged = stageFixture(source);
  const provenance = applyBrowserErrorPhaseObserver(staged.files);
  expect(JSON.stringify(source)).toBe(original);
  expect(provenance).toHaveLength(7);
  for (const row of provenance) expect(row.sha256).toBe(createHash("sha256").update(staged.files[row.path] ?? "").digest("hex"));
  expect(staged.files["pages/phase-sender-control.tsx"]).toContain("getServerSideProps");
  expect(staged.files["instrumentation.ts"]).toContain('process.env.NEXT_RUNTIME === "nodejs"');
  expect(staged.files["app/api/context/route.ts"]).toContain("observer: observerSnapshot()");
  expect(staged.files["load-components-descriptor.ts"]).toBeUndefined();
  expect(() => applyBrowserErrorPhaseObserver(staged.files)).toThrow("Context GET source changed");
  const changed = stageFixture(source);
  changed.files["app/api/context/route.ts"] = "changed upstream route";
  expect(() => applyBrowserErrorPhaseObserver(changed.files)).toThrow("refuse observer adaptation");
});

test("call wrappers preserve receiver, arguments, synchronous identity and falsy throws", () => {
  const receiver = {};
  const argument = {};
  const returned = {};
  const events: CallEvent[] = [];
  function original(this: unknown, value: unknown) { assert.equal(this, receiver); assert.equal(value, argument); return returned; }
  const wrapped = observeCall(original, event => events.push(event));
  expect(wrapped.call(receiver, argument)).toBe(returned);
  expect(wrapped.name).toBe(original.name);
  expect(wrapped.length).toBe(original.length);
  expect(events.map(event => event.stage)).toEqual(["entry", "return"]);
  for (const value of [undefined, null, false, 0, "", returned]) {
    assertThrownIdentity(() => observeCall(() => { throw value; }, () => { throw new Error("observer failure"); })(), value);
  }
});

test("settlement inspection cannot replace a returned revoked or trapping proxy", () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  expect(observeCall(() => revoked.proxy, () => {})()).toBe(revoked.proxy);
  const original = {};
  const trapped = new Proxy({}, { getPrototypeOf() { throw original; } });
  expect(observeCall(() => trapped, () => {})()).toBe(trapped);
});

function assertThrownIdentity(operation: () => unknown, expected: unknown): void {
  let caught = false;
  try { operation(); } catch (actual) { caught = true; expect(actual).toBe(expected); }
  expect(caught).toBe(true);
}

test("promise observers retain original promises and never assimilate fulfilled values or arbitrary thenables", async () => {
  const events: CallEvent[] = [];
  for (const value of [undefined, null, false, 0, "", {}]) await rejectedIdentity(value);
  let reads = 0;
  const accessor = { get then() { reads++; if (reads > 1) throw new Error("extra then read"); return undefined; } };
  const promise = Promise.resolve(accessor);
  expect(observeCall(() => promise, event => events.push(event))()).toBe(promise);
  expect(await promise).toBe(accessor);
  await Promise.resolve();
  expect(reads).toBe(1);
  expect(events.at(-1)).toEqual({ stage: "resolve", value: accessor });
  let thenableReads = 0;
  const thenable = { get then() { thenableReads++; throw new Error("thenable getter"); } };
  expect(observeCall(() => thenable, () => {})()).toBe(thenable);
  expect(thenableReads).toBe(0);
  let constructorReads = 0;
  const constructorGetterPromise = Promise.resolve("constructor-value");
  Object.defineProperty(constructorGetterPromise, "constructor", { configurable: true, get() { constructorReads++; return Promise; } });
  expect(observeCall(() => constructorGetterPromise, () => {})()).toBe(constructorGetterPromise);
  expect(constructorReads).toBe(0);
  const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  speciesReads = 0;
  if (speciesDescriptor?.configurable) {
    try {
      Object.defineProperty(Promise, Symbol.species, { configurable: true, get: readSpecies });
      const speciesPromise = Promise.resolve("species-value");
      expect(observeSpeciesPromise(speciesPromise)).toBe(speciesPromise);
      expect(speciesReads).toBe(0);
    } finally {
      Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
    }
  }
});

async function rejectedIdentity(value: unknown): Promise<void> {
  const events: CallEvent[] = [];
  const promise = Promise.reject(value);
  expect(observeCall(() => promise, event => events.push(event))()).toBe(promise);
  let caught = false;
  try { await promise; } catch (actual) { caught = true; expect(actual).toBe(value); }
  expect(caught).toBe(true);
  expect(events.at(-1)).toEqual({ stage: "reject", value });
}

test("the exact upstream nonconfigurable accessor is refused unchanged, without importing Next", () => {
  expect(originalSourceSha256).toBe("47e1446da77172ba77d6f3e6f68ae00ca7bebda206b26c0ba8625d41915dcaed");
  expect(createHash("sha256").update(exportPrelude).digest("hex")).toBe("256ebfc84088f214fc6e1441a68e65c273db5eae4a67114f467abac962234757");
  const exports = {};
  runInNewContext(exportPrelude, { exports, module: { exports } });
  const descriptor = Object.getOwnPropertyDescriptor(exports, "loadComponents");
  expect(descriptor?.configurable).toBe(false);
  expect(typeof descriptor?.get).toBe("function");
  expect(replaceMethod(exports, "loadComponents", original => observeCall(original, () => {}))).toBe(false);
  expect(Object.getOwnPropertyDescriptor(exports, "loadComponents")).toEqual(descriptor);
  const parent = { call: () => exports };
  const child = Object.create(parent);
  expect(shadowMethod(child, "call", original => observeCall(original, () => {}))).toBe(true);
  expect(child.call()).toBe(exports);
  expect(Object.hasOwn(child, "call")).toBe(true);
});

class BaseServer {
  async handleRequest(req: unknown, _res: unknown) { await Promise.resolve(); return req; }
  async renderErrorToResponseImpl() { return null; }
  async renderToResponseWithComponents() { return null; }
}
class NextNodeServer extends BaseServer {
  async sendRenderResult() { return null; }
  async findPageComponents() { return null; }
  async renderErrorToResponseImpl() { return null; }
}
class DevServer extends NextNodeServer {
  handleRequest(req: unknown, res: unknown) { return super.handleRequest(req, res); }
  ensurePage(value: { result?: unknown; fail?: boolean; error?: unknown }) { if (value.fail) throw value.error; return value.result; }
  async findPageComponents() { return null; }
}

test("installed fixture hooks use the public cache and distinct same-URL request objects without a listener", async () => {
  const provider = createRequire(process.cwd() + "/__serving_observer__.cjs");
  const cacheRows = [
    ["/next/dist/server/base-server.js", BaseServer],
    ["/next/dist/server/next-server.js", NextNodeServer],
    ["/next/dist/server/dev/next-dev-server.js", DevServer],
  ] as const;
  const originals = cacheRows.map(([path]) => ({ path: process.cwd() + path, value: Reflect.get(provider.cache, process.cwd() + path) }));
  const httpMethods = [{ prototype: Server.prototype, names: ["emit"] }, { prototype: ServerResponse.prototype, names: ["writeHead", "flushHeaders", "write", "end"] }];
  const descriptors = httpMethods.flatMap(({ prototype, names }) => names.map(name => ({ prototype, name, descriptor: Object.getOwnPropertyDescriptor(prototype, name) })));
  const env = { worker: process.env.NEXT_PRIVATE_WORKER, runtime: process.env.NEXT_RUNTIME };
  const sockets: Socket[] = [];
  try {
    for (const [path, value] of cacheRows) Reflect.set(provider.cache, process.cwd() + path, { exports: { default: value } });
    process.env.NEXT_PRIVATE_WORKER = "1";
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("./fixtures/browser-error-phase-observer/server-observer-runtime");
    await register();
    requireServingObserver(JSON.stringify({ pid: process.pid, observer: observerSnapshot() }));
    await exerciseInstalled(new DevServer(), sockets);
    expect(getObserverState().registration?.hooks.map(hook => hook.target).sort()).toEqual(observerHooks.toSorted());
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const row of descriptors) restoreProperty(row.prototype, row.name, row.descriptor);
    for (const row of originals) restoreCache(provider.cache, row.path, row.value);
    restoreEnvironment("NEXT_PRIVATE_WORKER", env.worker);
    restoreEnvironment("NEXT_RUNTIME", env.runtime);
    Reflect.deleteProperty(globalThis, Symbol.for("bun-wasm.browser-error-phase-observer"));
  }
});

function restoreProperty(target: object, name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);
}
function restoreCache(cache: object, path: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(cache, path);
  else Reflect.set(cache, path, value);
}
function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
async function exerciseInstalled(dev: DevServer, sockets: Socket[]): Promise<void> {
  exerciseMetadataReflection(dev);
  const returned = {};
  expect(dev.ensurePage({ result: returned })).toBe(returned);
  for (const value of [undefined, null, false, 0, "", returned]) assertThrownIdentity(() => dev.ensurePage({ fail: true, error: value }), value);
  const original = Promise.resolve(returned);
  expect(dev.ensurePage({ result: original })).toBe(original);
  await original;
  await Promise.all([taggedRequest(dev, sockets, "fixture-overlap-a"), taggedRequest(dev, sockets, "fixture-overlap-b")]);
  const rows = ["fixture-overlap-a", "fixture-overlap-b"].map(probe => getObserverState().records.filter(row => row.probe === probe));
  for (const records of rows) {
    expect(records.some(row => row.stage === "handle-request-base:resolve")).toBe(true);
    expect(new Set(records.map(row => row.details.requestId)).size).toBe(1);
  }
  expect(rows[0]?.[0]?.details.requestId).not.toBe(rows[1]?.[0]?.details.requestId);
}
function exerciseMetadataReflection(dev: DevServer): void {
  const productError = {};
  const observerError = {};
  for (const name of ["originalRequest", "req", "page", "url", "pathname", "shouldEnsure"]) {
    let reads = 0;
    let calls = 0;
    const argument = { get fail() { calls++; return true; }, error: productError };
    Object.defineProperty(argument, name, { get() { reads++; throw observerError; } });
    assertThrownIdentity(() => dev.ensurePage(argument), productError);
    expect(reads).toBe(0);
    expect(calls).toBe(1);
  }
  const trapped = new Proxy({ fail: true, error: productError }, { getOwnPropertyDescriptor() { throw observerError; } });
  assertThrownIdentity(() => dev.ensurePage(trapped), productError);
  let metadataReads = 0;
  const metadata = { get toJSON() { metadataReads++; throw observerError; } };
  const objectArgument = { page: metadata, fail: true, error: productError };
  assertThrownIdentity(() => dev.ensurePage(objectArgument), productError);
  expect(metadataReads).toBe(0);
  let reads = 0;
  const argument = { get page() { return ++reads; }, get result() { return this.page; } };
  expect(dev.ensurePage(argument)).toBe(1);
  expect(reads).toBe(1);
}

async function taggedRequest(dev: DevServer, sockets: Socket[], probe: string): Promise<void> {
  const socket = new Socket();
  sockets.push(socket);
  const req = new IncomingMessage(socket);
  req.url = "/same";
  req.headers["x-bun-writer-probe"] = probe;
  const res = new ServerResponse(req);
  const server = new Server();
  let result: unknown;
  server.on("request", (request, response) => { result = dev.handleRequest(request, response); });
  try { expect(server.emit("request", req, res)).toBe(true); expect(await result).toBe(req); }
  finally { server.removeAllListeners(); res.removeAllListeners(); req.removeAllListeners(); }
}

test("observer runtime never imports or replaces the refused Next function exports", () => {
  const runtime = readFileSync(join(import.meta.dir, "fixtures/browser-error-phase-observer/server-observer-runtime.ts"), "utf8");
  expect(runtime).toContain('createRequire(process.cwd() + "/__serving_observer__.cjs")');
  expect(runtime).not.toContain("load-components.js");
  expect(runtime).not.toContain("send-payload");
});
