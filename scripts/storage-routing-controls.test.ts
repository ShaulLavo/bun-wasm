import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instrumentHelper, instrumentRouter, instrumentWorker, instrumentSandbox } from "./storage-routing-build-source";

const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-routing-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
process.once("SIGTERM", () => { void rm(scratch, { recursive: true, force: true }).finally(() => process.exit(143)); });
process.once("SIGINT", () => { void rm(scratch, { recursive: true, force: true }).finally(() => process.exit(130)); });
const workerSource = await Bun.file(`${import.meta.dir}/../sandbox/node_modules/waffle/browser/service-worker.ts`).text();
const routerSource = await Bun.file(`${import.meta.dir}/../sandbox/node_modules/waffle/browser/preview.ts`).text();
await Bun.write(`${scratch}/worker.ts`, instrumentWorker(workerSource));
await Bun.write(`${scratch}/router.ts`, instrumentRouter(routerSource));
const originalWorker = await import("../sandbox/node_modules/waffle/browser/service-worker");
const originalRouter = await import("../sandbox/node_modules/waffle/browser/preview");
const observedWorker: typeof originalWorker = await import(`${scratch}/worker.ts`);
const observedRouter: typeof originalRouter = await import(`${scratch}/router.ts`);
const scope = "https://control.test/__preview/";
type Row = { kind: string; [key: string]: unknown };
const rows: Row[] = [];
Object.assign(globalThis, { __routingTrace: (row: Row) => rows.push(row) });

type Mode = "no-candidate" | "preview-only" | "missing-server" | "server-false" |
  "post-failure" | "timeout-late" | "success" | "multiple" | "sync-success";

async function control(mode: Mode, observed: boolean) {
  rows.length = 0;
  const routing = observed ? observedRouter : originalRouter;
  const worker = observed ? observedWorker : originalWorker;
  const router = new routing.PreviewRouter({ baseURL: "https://control.test/", prefix: "__preview" });
  const channels: MessageChannel[] = [];
  const calls: unknown[] = [];
  let late: (() => void) | undefined;
  const server: import("../sandbox/node_modules/waffle/browser/preview").PreviewServer = {
    request(port, request, sink) {
      expect(this).toBe(server);
      calls.push({ port, request: { ...request, body: Array.from(request.body ?? []) } });
      if (mode === "server-false") return false;
      const finish = () => {
        sink.head({ status: 201, statusText: "Created", headers: [["x-control", "yes"]] });
        sink.data(new TextEncoder().encode("native-port-body"));
        sink.end();
      };
      if (mode === "sync-success") finish();
      else queueMicrotask(finish);
      return true;
    },
    connect() { return null; },
  };
  if (mode !== "missing-server") router.register(5173, server);
  const page = {
    id: "page-A", url: "https://control.test/app-A",
    postMessage(message: Parameters<typeof router.onMessage>[0]["data"], ports: MessagePort[]) {
      expect(this).toBe(page);
      expect(ports).toHaveLength(1);
      calls.push({ ask: message, transferCount: ports.length });
      if (mode === "post-failure") throw new Error("injected post failure");
      const deliver = () => expect(router.onMessage({ data: message, ports })).toBeUndefined();
      if (mode === "timeout-late") late = deliver;
      else deliver();
    },
  };
  const absent = new routing.PreviewRouter({ baseURL: "https://control.test/", prefix: "__preview" });
  const other = {
    id: "page-B", url: "https://control.test/app-B",
    postMessage(data: Parameters<typeof router.onMessage>[0]["data"], ports: MessagePort[]) {
      absent.onMessage({ data, ports });
    },
  };
  const preview = { ...page, id: "iframe", url: `${scope}5173/` };
  let clients = [page];
  if (mode === "no-candidate") clients = [];
  if (mode === "preview-only") clients = [preview];
  if (mode === "multiple") clients = [preview, other, page];
  const adapter = worker.createPreviewServiceWorker({
    scope, clients: { get: async () => page, matchAll: async () => clients },
    fetch: async function(this: undefined) {
      expect(this).toBeUndefined();
      return new Response("network");
    },
    createChannel() {
      const channel = new MessageChannel();
      channels.push(channel);
      return channel;
    },
    unavailableResponse: () => new Response("No bun.wasm server is listening", { status: 502 }),
  });
  const start = performance.now();
  try {
    const response = await adapter.fetch(new Request(`${scope}5173/${mode}?control=1`, {
      method: "POST", body: "input", headers: { "x-control-request": "1" },
    }), "client-preview");
    const result = { status: response?.status, body: await response?.text(), calls };
    late?.();
    await new Promise(resolve => setTimeout(resolve, 10));
    const trace = rows.slice();
    return { result, trace, elapsedMs: performance.now() - start };
  } finally {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
  }
}

function expectClassification(mode: Mode, trace: Row[]) {
  const kinds = trace.map(row => row.kind);
  expect(kinds).toContain("forward");
  expect(kinds).toContain("discovery");
  if (mode === "no-candidate" || mode === "preview-only") {
    expect(kinds).not.toContain("claim-open");
    expect(kinds).toContain("unavailable");
    return;
  }
  expect(kinds).toContain("claim-open");
  if (mode === "post-failure") {
    expect(kinds).toContain("claim-post-failure");
    expect(kinds).not.toContain("claim-timeout");
    return;
  }
  if (mode === "timeout-late") {
    const expired = kinds.indexOf("claim-timeout");
    expect(expired).toBeGreaterThan(-1);
    expect(kinds.indexOf("page-receive")).toBeGreaterThan(expired);
    expect(trace.some(row => row.kind === "request-return" && row.accepted === true)).toBe(true);
    expect(trace.some(row => row.kind === "claim-reply" && row.reply === "accepted")).toBe(false);
    return;
  }
  const denied = mode === "missing-server" || mode === "server-false";
  expect(trace.some(row => row.kind === "claim-reply" && row.reply === (denied ? "none" : "head"))).toBe(true);
  if (mode === "missing-server") expect(trace.find(row => row.kind === "request-return")?.accepted).toBeNull();
  if (mode === "server-false") expect(trace.find(row => row.kind === "request-return")?.accepted).toBe(false);
}

for (const repetition of [1]) {
  for (const mode of ["no-candidate", "preview-only", "missing-server", "server-false", "post-failure", "timeout-late", "success", "multiple", "sync-success"] satisfies Mode[]) {
    test(`${repetition}: ${mode}: classified and same result/arguments as untouched source`, async () => {
      const plain = await control(mode, false);
      const observed = await control(mode, true);
      expect(observed.result).toEqual(plain.result);
      expectClassification(mode, observed.trace);

    }, 30000);
  }
}

test("observer sink failures do not alter success or errors", async () => {
  Object.assign(globalThis, { __routingTrace: () => { throw new Error("observer failed"); } });
  const result = await control("success", true);
  expect(result.result.status).toBe(201);
  const router = new observedRouter.PreviewRouter({ baseURL: scope, prefix: "x" });
  const marker = new Error("exact server failure");
  router.register(9, { request() { throw marker; }, connect() { return null; } });
  const channel = new MessageChannel();
  try {
    let caught: unknown;
    try { router.onMessage({ data: { type: "preview-request", port: 9, target: "/", method: "GET", headers: [], body: null }, ports: [channel.port2] }); }
    catch (error) { caught = error; }
    expect(caught).toBe(marker);
  } finally { channel.port1.close(); channel.port2.close(); }
});

test("source identity guard rejects changed inputs and exact consumer binding parses", async () => {
  expect(() => instrumentWorker(workerSource + "\n")).toThrow("Storage routing source differs");
  expect(() => instrumentRouter(routerSource + "\n")).toThrow("Storage routing source differs");

});

test("runtime binding retains only a scalar identity", () => {
  const source = "function bind(runtime) {\n    const sharedObjects = installBunSharedObjects(runtime);\n}";
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(instrumentSandbox(source));
  const bind = new Function("installBunSharedObjects", compiled + "\nreturn bind;")(() => undefined);
  const previews = {}, runtime = { stopped: true };
  Reflect.apply(bind, { previews, template: "vanilla" }, [runtime]);
  const identity = Reflect.get(globalThis, "__routingState").runtimes.get(previews);
  expect(typeof identity).toBe("number");
  expect(identity).toBeGreaterThan(0);
});

for (const target of ["/unrelated-stream.bin", "/src/main.ts"]) test(`streaming ${target} records bounded body progress`, async () => {
  const collected: Row[] = [];
  const previous = Reflect.get(globalThis, "__routingTrace");
  Reflect.set(globalThis, "__routingTrace", (row: Row) => collected.push(row));
  const channels: MessageChannel[] = [];
  const client = { id: "stream-owner", url: "https://control.test/app", postMessage(_ask: unknown, ports: MessagePort[]) {
    const port = ports[0]!;
    port.postMessage({ type: "head", status: 200, statusText: "OK", headers: [] });
    for (let chunk = 0; chunk < 5000; chunk++) port.postMessage({ type: "data", chunk: new Uint8Array([42]) });
    port.postMessage({ type: "end" });
    port.close();
  } };
  const worker = observedWorker.createPreviewServiceWorker({ scope,
    clients: { get: async () => client, matchAll: async () => [client] }, fetch: async () => new Response("network"),
    createChannel() { const channel = new MessageChannel(); channels.push(channel); return channel; },
  });
  try {
    const response = await worker.fetch(new Request(`${scope}5173${target}`), "preview");
    if (!response) throw Error("Missing original streamed response");
    expect((await response.arrayBuffer()).byteLength).toBe(5000);
    expect(collected.filter(row => row.kind === "claim-reply" && row.reply === "data")).toHaveLength(1);
    expect(collected.find(row => row.kind === "claim-reply" && row.reply === "end")?.bodyChunks).toBe(5000);
  } finally {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    Reflect.set(globalThis, "__routingTrace", previous);
  }
}, 30_000);

test("collector selects required targets before scalar transport without sequence gaps", async () => {
  const source = await Bun.file(`${import.meta.dir}/storage-routing-collector.ts`).text();
  const compiled = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
  const emitted: Row[] = [];
  const output = { debug(text: string) { expect(this).toBe(output); emitted.push(JSON.parse(text.slice("[storage-routing] ".length))); } };
  const previous = Reflect.get(globalThis, "__routingTrace");
  const enabled = Reflect.get(globalThis, "__bunwasmStorageFirstEvent");
  Reflect.set(globalThis, "__bunwasmStorageFirstEvent", true);
  try {
    const record = new Function("document", "location", "navigator", "console", compiled + "\nreturn record;")(
      {}, { href: "https://control.test/app" }, { serviceWorker: { addEventListener() {} } }, output);
    for (let chunk = 0; chunk < 5000; chunk++) record({ kind: "claim-reply", target: "/unrelated.bin", reply: "data" });
    record({ kind: "claim-reply", target: "/src/main.ts?updated=1", reply: "head" });
    expect(emitted.map(row => row.sequence)).toEqual([1, 2]);
    expect(emitted[1]?.target).toBe("/src/main.ts?updated=1");
  } finally {
    Reflect.set(globalThis, "__routingTrace", previous);
    if (enabled === undefined) Reflect.deleteProperty(globalThis, "__bunwasmStorageFirstEvent");
    else Reflect.set(globalThis, "__bunwasmStorageFirstEvent", enabled);
  }
});

test("replacement and stale unregister retain exact current server identity", () => {
  const trace: Row[] = [];
  Object.assign(globalThis, { __routingTrace: (row: Row) => trace.push(row) });
  const router = new observedRouter.PreviewRouter({ baseURL: scope, prefix: "x" });
  const old = { request() { return false; }, connect() { return null; } };
  const current = { ...old };
  router.register(9, old);
  router.register(9, current);
  router.unregister(9, old);
  expect(router.serves(9)).toBe(true);
  const stale = trace.find(row => row.kind === "unregister");
  expect(stale?.server).not.toBe(stale?.current);
  router.unregister(9, current);
  expect(router.serves(9)).toBe(false);
});

test("real helper adapter preserves receiver, arguments, result and error identity with a throwing sink", async () => {
  const helper = `${import.meta.dir}/../sandbox/node_modules/waffle/browser/net/helper.ts`;
  const result = await Bun.build({ entrypoints: [helper], target: "bun", outdir: scratch,
    plugins: [{ name: "real-helper-control", setup(build) {
      build.onLoad({ filter: /waffle\/browser\/net\/helper\.ts$/ }, async ({ path }) => ({ contents: instrumentHelper(await Bun.file(path).text()), loader: "ts" }));
    } }],
  });
  expect(result.success).toBe(true);
  const { NetHelper }: typeof import("../sandbox/node_modules/waffle/browser/net/helper") = await import(`${scratch}/helper.js`);
  const request = { method: "POST", target: "/input", headers: [], body: new Uint8Array([17, 23]) };
  const sink = { head() {}, data() {}, end() {}, error() {} };
  let connection: object | null = {};
  const thrown = { toString() { throw Error("toString failed"); } };
  let fail = false;
  const receiver = { requestConnection(...args: unknown[]) {
    expect(this).toBe(receiver); expect(args).toEqual([5173, request, sink]);
    if (fail) throw thrown;
    return connection;
  } };
  Reflect.set(globalThis, "__routingTrace", () => { throw Error("observer failed"); });
  expect(Reflect.apply(NetHelper.prototype.request, receiver, [5173, request, sink])).toBe(true);
  connection = null;
  expect(Reflect.apply(NetHelper.prototype.request, receiver, [5173, request, sink])).toBe(false);
  fail = true;
  let caught: unknown;
  try { Reflect.apply(NetHelper.prototype.request, receiver, [5173, request, sink]); }
  catch (error) { caught = error; }
  expect(caught).toBe(thrown);
});
