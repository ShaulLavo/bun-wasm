import { createContext, runInContext, type Context } from "node:vm";
import { expect, test } from "bun:test";
import { completeObservations, observeProductTraffic, productObservations, waitForPreviewReady, type ProductPage } from "./product-browser";
import type { ProductCheck } from "./product-types";
import { fullstackApps } from "./product-fullstack";
import { serverCommand } from "./browser.mjs";
import type { Page } from "../../web/node_modules/playwright";

interface FixtureOptions {
  updateMessage: string | null;
  domFailure?: boolean;
  replaceDocumentOnUpdate?: boolean;
  initFailure?: boolean;
  bindingDelay?: number;
  initialVisible?: string;
  hydration?: ReturnType<typeof hydrationGate>;
  restoration?: ReturnType<typeof hydrationGate>;
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
  let visible = options.initialVisible ?? "original";
  let source = "original";
  let documentReplacements = 0;
  let restoring = false;
  const initScripts: Array<() => void> = [];
  const bindings = new Map<string, (source: unknown, value: unknown) => void>();
  const writes: string[] = [];
  const visits: string[] = [];
  const locator = (selector: string, wanted = "") => ({
    filter: ({ hasText }: { hasText: string }) => locator(selector, hasText),
    async waitFor({ state }: { state?: "hidden" } = {}) {
      if (restoring && (state === "hidden" || (wanted === "original" && !visible.includes(wanted)))) await options.restoration?.wait();
      if (state === "hidden") {
        if (visible.includes(wanted)) throw new Error("Edited DOM is still visible");
        return;
      }
      if (selector.includes('[data-hydrated="true"]')) await options.hydration?.wait();
      if ((options.domFailure && wanted === "changed") || !visible.includes(wanted)) throw new Error("DOM did not update");
    },
    async click() {
      if (options.hydration?.buttonDisabled) await options.hydration.wait();
      options.hydration?.entered();
      if (!options.hydration || options.hydration.isReady()) visible = "action-result";
    },
    async count() { return visible.includes(wanted) ? 1 : 0; },
  });
  const installBindings = () => {
    for (const [name, callback] of bindings) {
      Object.defineProperty(context, name, {
        configurable: true,
        value: async (...args: unknown[]) => {
          if (options.bindingDelay) await new Promise(resolve => setTimeout(resolve, options.bindingDelay));
          callback({}, args[0]);
        },
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
      if (options.initFailure) throw new Error("init failed");
      initScripts.push(script);
      runInContext(`(${script.toString()})()`, context);
      return { async dispose() { initScripts.splice(initScripts.indexOf(script), 1); } };
    },
    async exposeBinding(name, callback) {
      bindings.set(name, callback);
      Object.defineProperty(context, name, {
        configurable: true,
        value: async (...args: unknown[]) => {
          if (options.bindingDelay) await new Promise(resolve => setTimeout(resolve, options.bindingDelay));
          callback({}, args[0]);
        },
      });
      return { async dispose() { bindings.delete(name); delete context[name]; } };
    },
    async evaluate<T>(pageFunction: () => T) { return runInContext(`(${pageFunction.toString()})()`, context); },
    locator,
    async goto(url) {
      visits.push(url);
      const path = new URL(url).pathname;
      visible = path.endsWith("/__preview/3137/") ? options.initialVisible ?? "original" : "route-result";
      setupPreviewSocket();
      return { ok: () => true, status: () => 200, text: async () => visible, headers: () => ({ "x-matrix": "verified" }) };
    },
  };
  const emit = (payload: string) => evaluate(context, `globalThis.__previewControllerPort?.postMessage({ kind: 'message', payload: ${JSON.stringify(payload)} });`);
  const finishRestoration = () => { visible = "original"; };
  const sourceAdapter = {
    async read() { return source; },
    async write(_path: string, contents: string) {
      options.hydration?.entered();
      if (options.hydration && !options.hydration.isReady()) throw new Error("Source edit preceded hydration");
      writes.push(contents);
      source = contents;
      if (contents === "original" && options.restoration) {
        restoring = true;
        if (options.updateMessage) emit(options.updateMessage);
        void options.restoration.wait().then(finishRestoration);
        return;
      }
      visible = contents;
      if (options.updateMessage) emit(options.updateMessage);
      else evaluate(context, "globalThis.__previewControllerPort?.postMessage({ kind: 'ping' });");
      if (contents === "changed" && options.replaceDocumentOnUpdate) replaceDocument();
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

function hydrationGate(buttonDisabled = true) {
  const ready = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  let hydrated = false;
  return {
    buttonDisabled,
    waiting: waiting.promise,
    entered: () => waiting.resolve(),
    isReady: () => hydrated,
    async wait() { waiting.resolve(); await ready.promise; },
    hydrate() { hydrated = true; ready.resolve(); },
  };
}

function hydratedDevCheck(id: string) {
  const app = fullstackApps.find(app => app.id === id);
  if (!app) throw new Error(`Missing ${id} fixture`);
  const check = app.commands.find(command => command.name === "dev")?.check;
  if (check?.kind !== "page") throw new Error(`Missing ${id} dev page check`);
  return { app, check };
}

for (const fixture of [
  { id: "fullstack-sveltekit", name: "SvelteKit", source: "src/routes/+page.svelte" },
  { id: "fullstack-tanstack-start", name: "TanStack", source: "src/routes/index.tsx" },
]) {
  test(`${fixture.name} delays the first source edit until client hydration`, async () => {
    const { check } = hydratedDevCheck(fixture.id);
    const hydration = hydrationGate();
    const run = fixtureWithHydration(hydration);
    const traffic = await observeProductTraffic(run.page);
    await run.open();
    try {
      const pending = productObservations(run.page, "http://local/", { ...check, hmr: hmrCheck().hmr, probes: [] }, run.source, traffic, 1000);
      await hydration.waiting;
      expect(run.writes).toEqual([]);
      hydration.hydrate();
      const rows = await pending;
      expect(rows[0]?.status).toBe("pass");
      expect(rows[0]?.assertion).toContain("vite:update");
      expect(run.writes).toEqual(["changed", "original"]);
    } finally { hydration.hydrate(); await traffic.close(); }
  });

  test(`${fixture.name} actions cannot click an SSR button before client hydration`, async () => {
    const { app, check } = hydratedDevCheck(fixture.id);
    const hydration = hydrationGate(app.files[fixture.source]?.includes('id="increment" disabled={!hydrated}'));
    const run = fixtureWithHydration(hydration, null);
    const pending = productObservations(run.page, "http://local/", { ...check, hmr: undefined, probes: [
      { kind: "action", id: "client-interaction", path: "/", button: "#increment", selector: "#count", text: "action-result" },
    ] }, run.source, { beginEdit: async () => {}, count: async () => 0, evidenceSince: async () => [] }, 1000);
    await hydration.waiting;
    hydration.hydrate();
    const rows = await pending;
    expect(rows[0]?.status).toBe("pass");
    expect(run.visits).toEqual(["http://local/"]);
  });
}

function fixtureWithHydration(hydration: ReturnType<typeof hydrationGate>, updateMessage: string | null = JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/page.tsx" }] })) {
  return fixture({ hydration, updateMessage });
}

test("HMR restoration completes before a later probe navigates", async () => {
  const restoration = hydrationGate();
  const run = fixture({ restoration, updateMessage: JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/page.tsx" }] }) });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  try {
    const pending = productObservations(run.page, "http://local/", { ...hmrCheck(), hmr: { path: "page.tsx", search: "original", replacement: "original changed" }, probes: [
      { kind: "route", id: "route", path: "/query", selector: "h1", text: "route-result" },
    ] }, run.source, traffic, 1000);
    await restoration.waiting;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(run.visits).toEqual(["http://local/__preview/3137/"]);
    restoration.hydrate();
    const rows = await pending;
    expect(rows.map(row => row.status)).toEqual(["pass", "pass"]);
  } finally { restoration.hydrate(); await traffic.close(); }
});

test("observes preview WebSocket messages over MessagePort after the edit boundary", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/src/App.tsx" }] }) });
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

test("a rejecting restore does not replace missing forward WebSocket evidence", async () => {
  const run = fixture({ updateMessage: null });
  const traffic = await observeProductTraffic(run.page);
  let restores = 0;
  const source = {
    read: run.source.read,
    async write(path: string, contents: string) {
      if (contents !== "original") return run.source.write(path, contents);
      restores++;
      throw new Error("restore write failed");
    },
  };
  await run.open();
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), source, traffic, 20);
  expect(rows[0]?.status).toBe("fail");
  expect(rows[0]?.blocker).toContain("Edited content appeared without a development WebSocket update");
  expect(rows[0]?.blocker).not.toContain("restore write failed");
  expect(restores).toBe(1);
  await traffic.close();
});

const originalForwardError = new Error("forward error");
originalForwardError.toString = () => "original Error identity";
for (const thrown of [originalForwardError, false, 0, null, undefined]) {
  test(`forward rejection ${String(thrown)} survives a rejecting restore`, async () => {
    const run = fixture({ updateMessage: null });
    const traffic = await observeProductTraffic(run.page);
    let restores = 0;
    const source = {
      read: run.source.read,
      async write(_path: string, contents: string) {
        if (contents !== "original") throw thrown;
        restores++;
        throw new Error("restore write failed");
      },
    };
    await run.open();
    const rows = await productObservations(run.page, "http://local/", hmrCheck(), source, traffic, 1000);
    expect(rows[0]?.blocker).toBe(String(thrown));
    expect(restores).toBe(1);
    await traffic.close();
  });
}

test("a rejecting rollback still fails after forward HMR passed", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "full-reload" }) });
  const traffic = await observeProductTraffic(run.page);
  const source = {
    read: run.source.read,
    async write(path: string, contents: string) {
      if (contents === "original") throw new Error("successful edit rollback failed");
      await run.source.write(path, contents);
    },
  };
  await run.open();
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), source, traffic, 1000);
  expect(rows[0]?.status).toBe("fail");
  expect(rows[0]?.blocker).toContain("successful edit rollback failed");
  await traffic.close();
});

test("preserves message arrival ordering, receiver behavior, exceptions, and cleanup", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/src/App.tsx" }] }) });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  await traffic.beginEdit();
  run.emit(JSON.stringify({ type: "ping" }));
  evaluate(run.context, `globalThis.__nativeSocket = new globalThis.NativeWebSocket(); globalThis.__nativeSocket.dispatchEvent(new globalThis.MessageEvent('message', { data: JSON.stringify({ type: 'update' }) }));`);
  run.emit(JSON.stringify({ type: "full-reload" }));
  expect(await traffic.count()).toBe(1);
  const evidence = await traffic.evidenceSince(0);
  expect(evidence.map(event => event.event)).toEqual(["full-reload"]);
  expect(() => evaluate(run.context, `globalThis.__plainTarget = new globalThis.EventTarget(); globalThis.__calls = 0; globalThis.__plainTarget.addEventListener('message', () => { globalThis.__calls++; throw new Error('receiver failure'); }); globalThis.__plainTarget.dispatchEvent(new globalThis.Event('message'));`)).toThrow("receiver failure");
  expect(run.context.__calls).toBe(1);
  await traffic.close();
  run.emit(JSON.stringify({ type: "update", updates: [{ type: "js-update", path: "/src/App.tsx" }] }));
  expect(await traffic.count()).toBe(1);
});

test("feature requests retain the service-worker preview prefix and assert actual responses", async () => {
  const run = fixture({ updateMessage: null });
  const traffic = { beginEdit: async () => {}, count: async () => 0, evidenceSince: async () => [] };
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


test("observer contract matches the pinned Playwright Page API", () => {
  const conforms: Page extends ProductPage ? true : false = true;
  expect(conforms).toBe(true);
});

test("setup failure releases the exposed binding", async () => {
  const run = fixture({ updateMessage: null, initFailure: true });
  await expect(observeProductTraffic(run.page)).rejects.toThrow("init failed");
  expect(run.context.__bunWasmProductTrafficReport).toBeUndefined();
});

test("closing removes both the binding and the init script before later navigation", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "update" }), replaceDocumentOnUpdate: true });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  await traffic.close();
  await traffic.close();
  await run.source.write("page.tsx", "changed");
  expect(run.context.__bunWasmProductTrafficReport).toBeUndefined();
  expect(run.context.__bunWasmProductTraffic).toBeUndefined();
  expect(await traffic.count()).toBe(0);
});


test("delayed pre-edit messages cannot qualify an edit", async () => {
  const run = fixture({ updateMessage: null, bindingDelay: 5 });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  run.emit(JSON.stringify({ type: "full-reload" }));
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), run.source, traffic, 30);
  expect(rows[0]?.status).toBe("fail");
  expect(await traffic.count()).toBe(0);
  await traffic.close();
});

test("waits for post-edit binding delivery even across document replacement", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "full-reload" }), bindingDelay: 5, replaceDocumentOnUpdate: true });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), run.source, traffic, 100);
  expect(rows[0]?.status).toBe("pass");
  expect(run.documentReplacements).toBe(1);
  await traffic.close();
});

test("requires a DOM transition rather than preexisting replacement text", async () => {
  const run = fixture({ updateMessage: JSON.stringify({ type: "full-reload" }), initialVisible: "original changed" });
  const traffic = await observeProductTraffic(run.page);
  await run.open();
  const rows = await productObservations(run.page, "http://local/", hmrCheck(), run.source, traffic, 100);
  expect(rows[0]?.status).toBe("fail");
  expect(rows[0]?.blocker).toContain("already visible");
  expect(run.writes).toEqual([]);
  await traffic.close();
});

test("empty update and generic Next envelopes do not qualify HMR", async () => {
  for (const payload of [{ type: "update", updates: [] }, { action: "turbopack-message", data: [] }, { action: "built" }]) {
    const run = fixture({ updateMessage: JSON.stringify(payload) });
    const traffic = await observeProductTraffic(run.page);
    await run.open();
    const rows = await productObservations(run.page, "http://local/", hmrCheck(), run.source, traffic, 20);
    expect(rows[0]?.status).toBe("fail");
    await traffic.close();
  }
});


interface ReadinessResponse {
  status: number;
  body: string;
}

function readinessResponse({ status, body }: ReadinessResponse) {
  return { ok: () => status >= 200 && status < 300, status: () => status, text: async () => body, headers: () => ({}), fromServiceWorker: () => true };
}

/** A probe page double: one scripted response per navigation, the last one repeating. */
function readinessProbe(responses: readonly ReadinessResponse[], log: string[] = []) {
  let navigations = 0;
  const probe = {
    get navigations() { return navigations; },
    context: () => ({ newCDPSession: async () => ({ send: async (method: string, params: { value: boolean }) => { log.push(`${method}:${params.value}`); } }) }),
    async goto(_url: string, options: { timeout: number; waitUntil: "commit" }) {
      log.push(`goto:${options.waitUntil}`);
      const response = responses[navigations] ?? responses.at(-1);
      navigations++;
      if (!response) throw new Error("Missing readiness response");
      return readinessResponse(response);
    },
    close: async () => { log.push("probe-close"); },
  };
  return probe;
}

test("waits for a listening server's transient HTTP 503 and closes the probe before one page navigation", async () => {
  const log: string[] = [];
  const probe = readinessProbe([{ status: 503, body: "server is starting" }, { status: 200, body: "ready" }], log);
  const preview = {
    on() {},
    exposeBinding: async () => ({ dispose: async () => {} }),
    addInitScript: async () => ({ dispose: async () => {} }),
    evaluate: async () => {},
    goto: async () => { log.push("page-navigation"); return readinessResponse({ status: 200, body: "ready" }); },
    locator: () => ({ filter: () => ({ waitFor: async () => {} }) }),
    screenshot: async () => {},
    close: async () => {},
  };
  const page = {
    evaluate: async (fn: () => unknown, text?: string) => {
      if (text) return;
      const source = fn.toString();
      if (source.includes("serving:")) return { done: false, serving: true };
      if (source.includes("previews.ready")) return "ready";
      if (source.includes("previews.url")) return "http://127.0.0.1/preview";
      if (source.includes("lastExit")) return 130;
      if (source.includes("__matrixCommand")) return false;
      return 0;
    },
    click: async () => {},
    keyboard: { press: async () => {} },
    waitForFunction: async () => {},
  };
  const pages = [preview, probe];
  const result = await serverCommand({
    page,
    context: { newPage: async () => pages.shift() },
    command: { name: "dev", args: ["run", "dev"], check: { kind: "http", text: "ready" } },
    app: { id: "readiness-fixture" },
    engine: "browser",
    options: { timeout: 1_000, output: process.env.TMPDIR ?? "/tmp" },
    terminalText: async () => "",
  });
  expect(result.status).toBe("pass");
  expect(log).toEqual(["Emulation.setScriptExecutionDisabled:true", "goto:commit", "goto:commit", "probe-close", "page-navigation"]);
});

test("a fast HTTP 2xx readiness response needs one script-disabled probe navigation", async () => {
  const log: string[] = [];
  const probe = readinessProbe([{ status: 200, body: "ready" }], log);
  await waitForPreviewReady(probe, "http://local/", Date.now() + 1_000);
  expect(log).toEqual(["Emulation.setScriptExecutionDisabled:true", "goto:commit"]);
});

test("persistent HTTP 503 readiness failure retains the last response body at the deadline", async () => {
  const probe = readinessProbe([{ status: 503, body: "first" }, { status: 503, body: "Nuxt dev server is starting..." }]);
  const started = performance.now();
  await expect(waitForPreviewReady(probe, "http://local/", Date.now() + 150)).rejects.toThrow("last HTTP 503: Nuxt dev server is starting...");
  expect(performance.now() - started).toBeLessThan(400);
  expect(probe.navigations).toBeGreaterThan(1);
});

test("an unexpected HTTP status fails without a retry", async () => {
  const probe = readinessProbe([{ status: 500, body: "server crashed" }, { status: 200, body: "ready" }]);
  await expect(waitForPreviewReady(probe, "http://local/", Date.now() + 1_000)).rejects.toThrow("Preview HTTP 500: server crashed");
  expect(probe.navigations).toBe(1);
});

test("preserves a non-deadline readiness navigation error", async () => {
  const transportError = new Error("net::ERR_FAILED");
  const probe = { ...readinessProbe([]), goto: async () => { throw transportError; } };
  await expect(waitForPreviewReady(probe, "http://local/", Date.now() + 1_000)).rejects.toBe(transportError);
});

test("readiness never starts a navigation after the shared deadline", async () => {
  const probe = readinessProbe([{ status: 503, body: "still starting" }]);
  await expect(waitForPreviewReady(probe, "http://local/", Date.now() - 1)).rejects.toThrow("not HTTP-ready before the deadline");
  expect(probe.navigations).toBe(0);
});

test("Next 16 typed build messages prove an edit and its restoration", async () => {
  const control = fixture({ updateMessage: JSON.stringify({ type: "built", hash: "next16-build" }) });
  const traffic = await observeProductTraffic(control.page);
  await control.open();
  try {
    const observations = await productObservations(control.page, "http://local/__preview/3137/", hmrCheck(), control.source, traffic, 1000);
    expect(observations.every(observation => observation.status === "pass")).toBe(true);
    expect(control.writes).toEqual(["changed", "original"]);
  } finally { await traffic.close(); }
});
