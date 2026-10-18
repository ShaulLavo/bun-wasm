import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Upstream } from "./first-visit-upstream.ts";

// A fresh proxy origin keeps both HTTP caches and service worker registrations empty. Delaying
// activate and resolving register() at "activating" exercises a timing browsers are allowed to use.
export async function firstVisit(context, base) {
  const upstream = new URL(base);
  const transport = new Upstream(upstream, upstream.protocol === "https:" ? "http2" : "http1");
  const server = createServer(forwardRequest.bind(null, upstream, transport));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await context.addInitScript(recordFirstVisit);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = new URL(upstream.pathname + upstream.search, origin).href;
  return {
    url,
    diagnostics: () => transport.snapshot(),
    async check(page, moduleScope = true) {
      const state = await page.evaluate(() => globalThis.__firstVisit);
      if (moduleScope) assert.ok(state.registrations.length, "first visit must register its module service worker");
      assert.ok(state.registrations.every((entry) => entry.returnedState === "activating"), JSON.stringify(state));
      assert.ok(state.workers.length, "first visit must start a Bun worker");
      if (moduleScope) assert.ok(state.workers.some((entry) => entry.scopeState), "browser engine must use its module scope");
      const premature = state.workers.filter((entry) => entry.scopeState && entry.scopeState !== "activated");
      assert.deepEqual(premature, [], "Bun worker started before its service worker finished activation");
      assert.deepEqual(state.errors, [], "first visit reported a worker error");
      // Safari can fetch the initial worker script from the network even after activation.
      // APIRequest bypasses service workers, so this cannot pass because a warm SW served it.
      const bootstrap = await context.request.get(new URL("./__bunwasm/worker.js", page.url()).href);
      assert.equal(bootstrap.status(), 200, "scoped worker bootstrap must exist on the static host");
      assert.match(bootstrap.headers()["content-type"] ?? "", /javascript/);
      assert.equal(bootstrap.headers()["cross-origin-embedder-policy"], "require-corp");
    },
    async close() {
      server.closeAllConnections();
      transport.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function forwardRequest(upstream, transport, incoming, outgoing) {
  const target = new URL(incoming.url, upstream.origin);
  // Works against the deployed https site too: the upstream sees its own Host, and asks for
  // uncompressed bodies because sw.js is rewritten as text below.
  const headers = { ...incoming.headers, host: target.host, "accept-encoding": "identity" };
  const fail = (error) => {
    if (outgoing.destroyed) return;
    console.error(`first-visit proxy ${target.href}:`, error);
    outgoing.destroy(error);
  };
  let forwarded;
  try {
    forwarded = transport.request(target, {
      method: incoming.method,
      headers,
      autoSelectFamilyAttemptTimeout: 2_000,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    fail(error);
    return;
  }
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) forwarded.writable.destroy();
  });
  forwarded.writable.on("error", fail);
  forwarded.response.then(response => forwardResponse(target, outgoing, response, fail)).catch(fail);
  incoming.pipe(forwarded.writable);
}

function forwardResponse(target, outgoing, response, fail) {
  const body = response.body;
  if (outgoing.destroyed) return body.destroy();
  if (body.destroyed && !body.readableEnded) return fail(body.errored ?? new Error("Upstream response closed early"));
  body.on("error", fail);
  body.once("close", () => {
    if (!body.readableEnded) fail(body.errored ?? new Error("Upstream response closed early"));
  });
  const headers = { ...response.headers };
  delete headers["content-length"];
  outgoing.writeHead(response.statusCode, headers);
  if (!target.pathname.endsWith("/sw.js")) return void body.pipe(outgoing);
  let source = "";
  body.setEncoding("utf8");
  body.on("data", (chunk) => (source += chunk));
  body.on("end", () => outgoing.end(ACTIVATION_DELAY + source));
}

const ACTIVATION_DELAY = `self.addEventListener("activate", event => event.waitUntil(new Promise(resolve => setTimeout(resolve, 6000))));\n`;

function recordFirstVisit() {
  if (!navigator.serviceWorker) return;
  const state = (globalThis.__firstVisit = { registrations: [], workers: [], errors: [] });
  const registrations = new Map();
  const originalRegister = ServiceWorkerContainer.prototype.register;
  const activationStarted = (worker) => ["activating", "activated", "redundant"].includes(worker.state);
  ServiceWorkerContainer.prototype.register = async function (...args) {
    const registration = await originalRegister.apply(this, args);
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (worker && !activationStarted(worker)) await new Promise((resolve) => worker.addEventListener("statechange", () => activationStarted(worker) && resolve()));
    registrations.set(registration.scope, registration);
    state.registrations.push({ scope: registration.scope, returnedState: worker?.state });
    return registration;
  };
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      const href = new URL(url, location.href).href;
      const registration = Array.from(registrations.values()).find((entry) => href.startsWith(entry.scope));
      state.workers.push({ url: href, scopeState: registration?.active?.state });
      super(url, options);
      this.addEventListener("error", (event) => state.errors.push(event.message ?? "worker load failed"));
    }
  };
}
