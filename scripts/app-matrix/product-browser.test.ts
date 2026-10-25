import { createContext, runInContext, type Context } from "node:vm";
import { expect, test } from "bun:test";
import { completeObservations, observeProductTraffic, productObservations, type ProductPage } from "./product-browser";
import type { ProductCheck } from "./product-types";

interface FixtureOptions {
  updateMessage: string | null;
  domFailure?: boolean;
  replaceDocumentOnUpdate?: boolean;
}

interface Fixture {
  context: Context;
  page: ProductPage;
  source: { read(path: string): Promise<string | null>; write(path: string, contents: string): Promise<void> };
  writes: string[];
  visits: string[];
  documentReplacements: number;
  current(): string;
  emit(payload: string): void;
  open(): Promise<void>;
}

function createPreviewContext(): Context {
  const context = createContext({ TextDecoder, TextEncoder, ArrayBuffer, Uint8Array, JSON, Reflect, Set });
  runInContext(`
    class EventTarget {
      constructor() { this.listeners = new Map(); }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      dispatchEvent(event) {
        event.target = this;
        for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
        const handler = this['on' + event.type];
        if (typeof handler === 'function') handler.call(this, event);
        return true;
      }
    }
    class Event {
      constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
    }
    class MessageEvent extends Event {}
    class MessagePort extends EventTarget {
      postMessage(data) { this.peer?.dispatchEvent(new MessageEvent('message', { data })); }
      close() { this.closed = true; }
    }
    class MessageChannel {
      constructor() {
        this.port1 = new MessagePort();
        this.port2 = new MessagePort();
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
      }
    }
    class NativeWebSocket extends EventTarget {}
    class RuntimeWebSocket extends EventTarget {}
    class PreviewWebSocket extends RuntimeWebSocket {
      constructor() {
        super();
        const channel = new MessageChannel();
        this.port = channel.port1;
        globalThis.__previewControllerPort = channel.port2;
        this.port.onmessage = event => {
          if (event.data.kind === 'message') this.dispatchEvent(new MessageEvent('message', { data: event.data.payload }));
          if (event.data.kind === 'ping') this.dispatchEvent(new Event('ping'));
        };
      }
    }
    globalThis.EventTarget = EventTarget;
    globalThis.Event = Event;
    globalThis.MessageEvent = MessageEvent;
    globalThis.MessagePort = MessagePort;
    globalThis.MessageChannel = MessageChannel;
    globalThis.WebSocket = NativeWebSocket;
    globalThis.NativeWebSocket = NativeWebSocket;
    globalThis.PreviewWebSocket = PreviewWebSocket;
  `, context);
  return context;
}

function evaluate(context: Context, source: string): void {
  runInContext(source, context);
}

function fixture(options: FixtureOptions): Fixture {
  let context = createPreviewContext();
  let visible = "original";
  let source = "original";
  let documentReplacements = 0;
  const initScripts: Array<() => void> = [];
  const bindings = new Map<string, (source: unknown, value: unknown) => void>();
  const writes: string[] = [];
  const visits: string[] = [];
  const locator = (wanted = "") => ({
    filter: ({ hasText }: { hasText: string }) => locator(hasText),
    async waitFor() {
      if (options.domFailure || !visible.includes(wanted)) throw new Error("DOM did not update");
    },
    async click() { visible = "action-result"; },
  });
  const installBindings = () => {
    for (const [name, callback] of bindings) {
      Object.defineProperty(context, name, {
        configurable: true,
        value: (...args: unknown[]) => callback({}, args[0]),
      });
    }
    for (const script of initScripts) runInContext(`(${script.toString()})()`, context);
  };
  const setupPreviewSocket = () => evaluate(context, "globalThis.WebSocket = globalThis.PreviewWebSocket; globalThis.__previewSocket = new globalThis.PreviewWebSocket();");
  const replaceDocument = () => {
    context = createPreviewContext();
    documentReplacements++;
    visible = source;
    installBindings();
    setupPreviewSocket();
  };
  const page: ProductPage = {
    async addInitScript(script) {
      initScripts.push(script);
      runInContext(`(${script.toString()})()`, context);
    },
    async exposeBinding(name, callback) {
      bindings.set(name, callback);
      Object.defineProperty(context, name, {
        configurable: true,
        value: (...args: unknown[]) => callback({}, args[0]),
      });
    },
    async removeExposedBinding(name) {
      bindings.delete(name);
      delete context[name];
    },
    async evaluate<T>(pageFunction: () => T) { return runInContext(`(${pageFunction.toString()})()`, context); },
    locator,
    async goto(url) {
      visits.push(url);
      const path = new URL(url).pathname;
      visible = path.endsWith("/__preview/3137/") ? "original" : "route-result";
      setupPreviewSocket();
      return { ok: () => true, status: () => 200, text: async () => visible, headers: () => ({ "x-matrix": "verified" }) };
    },
  };
  const emit = (payload: string) => evaluate(context, `globalThis.__previewControllerPort?.postMessage({ kind: 'message', payload: ${JSON.stringify(payload)} });`);
  const sourceAdapter = {
    async read() { return source; },
    async write(_path: string, contents: string) {
      writes.push(contents);
      source = contents;
      visible = contents;
      if (contents !== "changed") return;
      if (options.updateMessage) emit(options.updateMessage);
      else evaluate(context, "globalThis.__previewControllerPort?.postMessage({ kind: 'ping' });");
      if (options.replaceDocumentOnUpdate) replaceDocument();
    },
  };
  return {
    get context() { return context; },
    page,
    source: sourceAdapter,
    writes,
    visits,
    get documentReplacements() { return documentReplacements; },
    current: () => source,
    emit,
    async open() { await page.goto("http://local/__preview/3137/", { timeout: 1000 }); },
  };
}

function hmrCheck() {
  return { kind: "page", selector: "h1", text: "original", hmr: { path: "page.tsx", search: "original", replacement: "changed" } } satisfies ProductCheck;
}

test("observes preview WebSocket messages over MessagePort after the edit boundary", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "update", updates: [] }) });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  run.emit(JSON.stringify({ type: "connected" }));
  const rows = await productObservations(run.page, "http://local/__preview/3137/", hmrCheck(), run.source, traffic, 1000);
  expect(rows.map(row => row.status)).toEqual(["pass"]);
  expect(rows[0]?.assertion).toContain("vite:update");
  expect(run.writes).toEqual(["changed", "original"]);
  expect(run.current()).toBe("original");
  await traffic.close();
});

test("retains full-reload evidence when HMR replaces the document", async () => {
  const run = fixture({
    updateMessage: JSON.stringify({ type: "full-reload", path: "/src/App.tsx" }),
    replaceDocumentOnUpdate: true,
  });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  const rows = await productObservations(run.page, "http://local/__preview/3137/", hmrCheck(), run.source, traffic, 1000);
  expect(rows[0]?.status).toBe("pass");
  expect(rows[0]?.assertion).toContain("vite:full-reload");
  expect(run.documentReplacements).toBe(1);
  expect(run.writes).toEqual(["changed", "original"]);
  expect(run.current()).toBe("original");
  await traffic.close();
});

test("recognizes Next named HMR actions instead of requiring Vite's type field", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ action: "serverComponentChanges", hash: "next-hash" }) });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  const rows = await productObservations(run.page, "http://local/__preview/3137/", hmrCheck(), run.source, traffic, 1000);
  expect(rows[0]?.status).toBe("pass");
  expect(rows[0]?.assertion).toContain("next:serverComponentChanges");
  await traffic.close();
});

test("rejects unrelated ping traffic even when the edited DOM changes", async () => {
  const run = fixture({ updateMessage: null });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), run.source, traffic, 1000);
  expect(rows[0]?.status).toBe("fail");
  expect(rows[0]?.blocker).toContain("recognized Vite or Next HMR message");
  expect(run.current()).toBe("original");
  await traffic.close();
});

test("restores the guest source when the DOM assertion fails", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "full-reload" }), domFailure: true });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), run.source, traffic, 1000);
  expect(rows[0]?.status).toBe("fail");
  expect(run.writes).toEqual(["changed", "original"]);
  expect(run.current()).toBe("original");
  await traffic.close();
});

test("preserves message arrival ordering, receiver behavior, exceptions, and cleanup", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "update", updates: [] }) });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  run.emit(JSON.stringify({ type: "ping" }));
  evaluate(run.context, `globalThis.__nativeSocket = new globalThis.NativeWebSocket(); globalThis.__nativeSocket.dispatchEvent(new globalThis.MessageEvent('message', { data: JSON.stringify({ type: 'update' }) }));`);
  run.emit(JSON.stringify({ type: "full-reload" }));
  expect(await traffic.count()).toBe(1);
  const evidence = await traffic.evidenceSince(0);
  expect(evidence.map(event => event.event)).toEqual(["full-reload"]);
  await traffic.close();
  run.emit(JSON.stringify({ type: "update", updates: [] }));
  expect(await traffic.count()).toBe(1);
  expect(() => evaluate(run.context, `globalThis.__plainTarget = new globalThis.EventTarget(); globalThis.__plainTarget.addEventListener('message', () => { throw new Error('receiver failure'); }); globalThis.__plainTarget.dispatchEvent(new globalThis.Event('message'));`)).toThrow("receiver failure");
});

test("feature requests retain the service-worker preview prefix and assert actual responses", async () => {
  const run = fixture({ updateMessage: null });
  const traffic = { count: async () => 0, evidenceSince: async () => [] };
  const check = { kind: "page", selector: "h1", text: "original", probes: [
    { kind: "route", id: "ssr", path: "/server", selector: "h1", text: "route-result" },
    { kind: "action", id: "action", path: "/action", button: "button", selector: "output", text: "action-result" },
    { kind: "response", id: "middleware", path: "/api", status: 200, header: { name: "X-Matrix", value: "verified" } },
  ] } satisfies ProductCheck;
  const rows = await productObservations(run.page, "http://local/__preview/3137/", check, run.source, traffic, 1000);
  expect(rows.map(row => row.status)).toEqual(["pass", "pass", "pass"]);
  expect(run.visits).toEqual([
    "http://local/__preview/3137/server",
    "http://local/__preview/3137/action",
    "http://local/__preview/3137/api",
  ]);
});

test("unrun hot-edit and feature stages stay blocked rather than disappearing or passing", () => {
  const check = { kind: "page", selector: "h1", text: "original", hmr: { path: "page.tsx", search: "original", replacement: "changed" }, probes: [
    { kind: "route", id: "ssr", path: "/server", selector: "h1", text: "route-result" },
  ] } satisfies ProductCheck;
  expect(completeObservations(check, [], { status: "fail", blocker: "HTTP 500" })).toEqual([
    { stage: "hmr", status: "blocked", blocker: "HTTP 500" },
    { stage: "ssr", status: "blocked", blocker: "HTTP 500" },
  ]);
});
