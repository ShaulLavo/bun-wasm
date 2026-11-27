import { expect, test } from "bun:test";
import { outcomeWord } from "waffle/proc/outcome";
import { processRuntimeFixture } from "./process-runtime-fixture";
import { networkPathScopeFixture, socketDirectoryFixture } from "./socket-runtime-fixture";
import type { ProcessService, RuntimeProcessContext } from "waffle";
import { bunLauncher } from "../src/bun-launcher";
import type { RunRequest } from "../src/bun-executor";

test("no relay keeps loopback and rejects external TCP with ENOTSUP", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const network = await runtime.network();
  const ring = createRing();
  const helper = createBunNetworkHelper(network, ring);
  const host = new NetHost(ring, request => dispatchBunNetwork(helper, { type: "net", req: request }), undefined, { shared: true });
  try {
    const listener = host.listen("localhost", 0);
    const port = host.localPort(listener);
    const client = host.connect("localhost", port);
    expect(client).toBeGreaterThan(0);
    await Bun.sleep(0);
    expect(host.accept(listener)).toBeGreaterThan(0);
    const external = host.connect("outside.example", 443);
    expect(external).toBeLessThan(0);
    expect(JSON.parse(String(host.error(0)))).toMatchObject({ code: "ENOTSUP" });
  } finally {
    host.dispose();
    helper.dispose();
    await runtime.dispose();
  }
});

test("Bun child launches receive a per-process networking ring", async () => {
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const context = { identity: { pid: 1, parentPid: 0, host: null }, outcome: outcomeWord(), registerRevocation: () => () => {}, module, interruptible: false, request: { executable: "/bin/bun", argv: ["bun", "-e", "0"], env: {}, cwd: "/" } } as unknown as RuntimeProcessContext;
  let request: RunRequest | undefined;
  const service = { networkPathScope: networkPathScopeFixture, launchWorker(_context: unknown, options: { request: RunRequest }) { request = options.request; return { terminate() {} }; } } as unknown as ProcessService;
  const options = { workerUrl: "https://example.test/worker.js", notificationWorkerUrl: "https://example.test/notification-worker.js", runtime: processRuntimeFixture({ directoryHandle: socketDirectoryFixture }) };
  try {
    await bunLauncher("browser", options)(context, service);
    expect(request?.net).toBeInstanceOf(SharedArrayBuffer);
  } finally { await options.runtime.dispose(); }
});

import { NetHost } from "waffle/browser/net/host";
import { createRing } from "waffle/browser/net/ring";
import { AGAIN } from "waffle/browser/net/protocol";
import { createBunNetworkHelper, dispatchBunNetwork, type BunNetworkOptions, type RuntimeNetworkHelper } from "../src/net/helper";
import { claimOutcome } from "waffle/proc/outcome";

test("borrowed sessions share ports, duplex bytes, half-close and release only their owner", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const network = await runtime.network();
  const stopped: number[] = [];
  const make = () => {
    const ring = createRing();
    const helper = createBunNetworkHelper(network, ring, { stopped: port => stopped.push(port) });
    return { helper, host: new NetHost(ring, req => dispatchBunNetwork(helper, { type: "net", req }), undefined, { shared: true }) };
  };
  const a = make(), b = make(), c = make();
  try {
    const listener = a.host.listen("localhost", 0);
    const port = a.host.localPort(listener);
    expect(b.host.listen("localhost", port)).toBeLessThan(0);
    const client = b.host.connect("localhost", port);
    await Bun.sleep(0);
    const accepted = a.host.accept(listener);
    expect(accepted).toBeGreaterThan(0);
    expect(b.host.write(client, new TextEncoder().encode("request"))).toBe(7);
    await Bun.sleep(0);
    expect(a.host.read(accepted, 100)).toEqual(new TextEncoder().encode("request"));
    expect(a.host.shutdown(accepted)).toBe(0);
    await Bun.sleep(0);
    expect(b.host.read(client, 100)).toBe(0);
    expect(b.host.write(client, new Uint8Array([1]))).toBe(1);
    await Bun.sleep(0);
    expect(a.host.read(accepted, 100)).toEqual(new Uint8Array([1]));
    c.helper.dispose(); c.helper.dispose();
    expect(b.host.connect("localhost", port)).toBeGreaterThan(0);
    a.helper.dispose(); a.helper.dispose();
    expect(stopped).toEqual([port]);
    expect(b.host.connect("localhost", port)).toBeLessThan(0);
    expect(b.host.listen("localhost", port)).toBeGreaterThan(0);
  } finally { a.helper.dispose(); b.helper.dispose(); c.helper.dispose(); await runtime.dispose(); }
});

test("separate network owners isolate ports and release pending accepts without foreign harm", async () => {
  const first = processRuntimeFixture({ directoryHandle: socketDirectoryFixture }), second = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const make = async (runtime: ReturnType<typeof processRuntimeFixture>) => {
    const ring = createRing();
    const helper = createBunNetworkHelper(await runtime.network(), ring);
    return { helper, host: new NetHost(ring, req => helper.handle(req), undefined, { shared: true }) };
  };
  const a = await make(first), b = await make(second);
  try {
    expect(a.host.listen("localhost", 31891)).toBeGreaterThan(0);
    const listener = b.host.listen("localhost", 31891);
    expect(listener).toBeGreaterThan(0);
    expect(b.host.accept(listener)).toBe(AGAIN);
    await first.dispose();
    expect(b.host.connect("localhost", 31891)).toBeGreaterThan(0);
    await Bun.sleep(0);
    expect(b.host.accept(listener)).toBeGreaterThan(0);
  } finally { await first.dispose(); await second.dispose(); }
});

test("injected fetch is used without replacing standalone installer policy", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const ring = createRing();
  const calls: string[] = [];
  const helper = createBunNetworkHelper(await runtime.network(), ring, { fetch: async url => { calls.push(url); return new Response("policy body"); } });
  const host = new NetHost(ring, req => helper.handle(req), undefined, { shared: true });
  try {
    const handle = host.fetch(JSON.stringify({ url: "https://policy.invalid/", method: "GET" }), null);
    for (let turn = 0; turn < 100 && host.fetchHead(handle) === AGAIN; turn++) await Bun.sleep(1);
    expect(calls).toEqual(["https://policy.invalid/"]);
    expect(host.read(handle, 100)).toEqual(new TextEncoder().encode("policy body"));
    expect(() => dispatchBunNetwork(helper, { type: "net", req: { type: "tcp-write", id: 1, reply: new SharedArrayBuffer(1), data: [] } })).toThrow("Invalid Bun network request");
  } finally { helper.dispose(); await runtime.dispose(); }
});

test("child launch revocation during activation allocates no session", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const capability = await runtime.network();
  const gate = Promise.withResolvers<typeof capability>();
  let allocations = 0, revoke = () => {};
  runtime.network = () => gate.promise;
  const network = { lookup: capability.lookup.bind(capability), createHelper(options: Parameters<typeof capability.createHelper>[0]) { allocations++; return capability.createHelper(options); } };
  const context = { identity: { pid: 1, parentPid: 0, host: null }, module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), outcome: outcomeWord(), registerRevocation(hook: () => void) { revoke = hook; return () => {}; }, request: { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/" } } as unknown as RuntimeProcessContext;
  const service = { networkPathScope: networkPathScopeFixture, launchWorker() { throw new Error("must not launch"); } } as unknown as ProcessService;
  try {
    const launching = bunLauncher("browser", { runtime, workerUrl: "https://example.test/worker.js", notificationWorkerUrl: "./notification-worker.js" })(context, service);
    revoke(); gate.resolve(network);
    await expect(launching).rejects.toThrow("revoked");
    expect(allocations).toBe(0);
  } finally { await runtime.dispose(); }
});

test("child helper lives until physical cleanup, not its logical outcome or adapter lifetime", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const revocations: (() => void)[] = [];
  const context = { identity: { pid: 1, parentPid: 0, host: null }, module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), outcome: outcomeWord(), registerRevocation(hook: () => void) { revocations.push(hook); return () => {}; }, request: { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/" } } as unknown as RuntimeProcessContext;
  const stopped: number[] = [];
  let helper: RuntimeNetworkHelper | undefined;
  const options: BunNetworkOptions = { listening(_port, owner) { helper = owner; }, stopped: port => stopped.push(port) };
  let launch: Parameters<ProcessService["launchWorker"]>[1] | undefined;
  const service = { networkPathScope: networkPathScopeFixture, launchWorker(_context: unknown, value: typeof launch) { launch = value; return { terminate() {} }; } } as unknown as ProcessService;
  try {
    await bunLauncher("browser", { runtime, workerUrl: "https://example.test/worker.js", notificationWorkerUrl: "./notification-worker.js", network: options })(context, service);
    if (!launch) throw new Error("missing launch");
    const request = launch.request as RunRequest;
    const host = new NetHost(request.net!, req => launch!.onMessage?.({ type: "net", req }, context), undefined, { shared: true });
    const listener = host.listen("localhost", 31892);
    expect(listener).toBeGreaterThan(0);
    claimOutcome(context.outcome, { kind: "exited", code: 0 });
    // Waffle revokes an exited process too; only a signal death releases the session early.
    for (const hook of revocations) hook();
    expect(revocations).toHaveLength(1);
    expect(stopped).toEqual([]);
    expect(helper?.listenerFor(31892)).toBeGreaterThan(0);
    launch.cleanup?.(); launch.cleanup?.();
    expect(stopped).toEqual([31892]);
  } finally { launch?.cleanup?.(); await runtime.dispose(); }
});

// Restart kills the old dev server and starts a new one on the same port. The old Worker may never
// physically stop (WebKit cannot terminate one parked in a Wasm wait), so its cleanup never runs.
test("a killed child frees its port when the kill is decided, before its Worker stops", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const stopped: number[] = [];
  const network: BunNetworkOptions = { stopped: port => stopped.push(port) };
  const launches: Parameters<ProcessService["launchWorker"]>[1][] = [];
  const service = { networkPathScope: networkPathScopeFixture, launchWorker(_context: unknown, value: Parameters<ProcessService["launchWorker"]>[1]) { launches.push(value); return { terminate() {} }; } } as unknown as ProcessService;
  const launch = async (pid: number) => {
    const revocations: (() => void)[] = [];
    const context = { identity: { pid, parentPid: 0, host: null }, module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])), outcome: outcomeWord(), registerRevocation(hook: () => void) { revocations.push(hook); return () => {}; }, request: { executable: "/bin/node", argv: ["node", "vite"], env: {}, cwd: "/" } } as unknown as RuntimeProcessContext;
    await bunLauncher("browser", { runtime, workerUrl: "https://example.test/worker.js", notificationWorkerUrl: "./notification-worker.js", network })(context, service);
    const launched = launches.at(-1)!;
    const host = new NetHost((launched.request as RunRequest).net!, req => launched.onMessage?.({ type: "net", req }, context), undefined, { shared: true });
    return { context, host, revoke: () => { for (const hook of revocations) hook(); } };
  };
  try {
    const old = await launch(4);
    expect(old.host.listen("127.0.0.1", 31893)).toBeGreaterThan(0);
    // Waffle selects the SIGKILL outcome, then runs revocation hooks; no physical cleanup follows.
    claimOutcome(old.context.outcome, { kind: "signaled", code: 9 });
    old.revoke();
    expect(stopped).toEqual([31893]);
    const replacement = await launch(8);
    expect(replacement.host.listen("127.0.0.1", 31893)).toBeGreaterThan(0);
  } finally {
    for (const launched of launches) launched.cleanup?.();
    await runtime.dispose();
  }
});

for (const phase of ["before launch", "during tools load"] as const) test(`revoked child never activates networking ${phase}`, async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const capability = await runtime.network();
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const loading = Promise.withResolvers<WebAssembly.Module>();
  let activations = 0, loads = 0, revoke = () => {};
  runtime.network = async () => { activations++; return capability; };
  const context = { identity: { pid: 1, parentPid: 0, host: null }, module, outcome: outcomeWord(), registerRevocation(hook: () => void) { revoke = hook; return () => {}; }, request: { executable: "/bin/bun", argv: ["bun", "lint", "input.ts"], env: {}, cwd: "/" } } as unknown as RuntimeProcessContext;
  const service = { networkPathScope: networkPathScopeFixture, launchWorker() { throw new Error("must not launch"); } } as unknown as ProcessService;
  try {
    if (phase === "before launch") claimOutcome(context.outcome, { kind: "start-failed", code: 13 });
    const launching = bunLauncher("browser", { runtime, workerUrl: "https://example.test/worker.js", notificationWorkerUrl: "./notification-worker.js", loadTools() { loads++; return loading.promise; } })(context, service);
    revoke(); loading.resolve(module);
    await expect(launching).rejects.toThrow("revoked");
    expect(activations).toBe(0);
    expect(loads).toBe(phase === "before launch" ? 0 : 1);
  } finally { loading.resolve(module); await runtime.dispose(); }
});

test("Runtime-borrowed helpers retain the default installer tarball cache policy", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  const opened: string[] = [];
  const ring = createRing();
  const helper = createBunNetworkHelper(await runtime.network(), ring);
  const host = new NetHost(ring, req => helper.handle(req), undefined, { shared: true });
  const cache = { async open(name: string) { opened.push(name); return { async match() { return new Response("cached runtime tarball"); } }; } };
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: cache });
    globalThis.fetch = Object.assign(async () => { throw new Error("cached tarball must not reach external fetch"); }, { preconnect: originalFetch.preconnect });
    const handle = host.fetch(JSON.stringify({ url: "https://network.invalid/pkg.tgz", headers: [["accept", "application/vnd.bun.install-tarball"]] }));
    for (let turn = 0; turn < 100 && host.fetchHead(handle) === AGAIN; turn++) await Bun.sleep(1);
    expect(host.read(handle, 100)).toEqual(new TextEncoder().encode("cached runtime tarball"));
    expect(opened).toEqual(["bun-wasm-install-v1"]);
  } finally {
    helper.dispose(); await runtime.dispose(); globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else Reflect.deleteProperty(globalThis, "caches");
  }
});

import { runtimeRelay } from "../src/net/relay";

type TestRelay = NonNullable<Awaited<ReturnType<typeof runtimeRelay>>>;

function relayOptions(counter: { calls: number }) {
  return {
    endpoint: "http://127.0.0.1:1/",
    carriers: ["websocket"] as const,
    getToken(): string {
      counter.calls++;
      throw new Error("source-only token marker, stop before I/O");
    },
  };
}

async function refusedRelayConnect(relay: TestRelay): Promise<unknown> {
  try {
    await relay.connect({ host: "source-only.example", port: 4321 }, new AbortController().signal);
  } catch (error) {
    return error;
  }
  throw new Error("Expected the revoked relay to reject connection");
}

test("relay initialization cannot create a live connector after runtime disposal", async () => {
  const runtime = processRuntimeFixture({});
  const counter = { calls: 0 };
  const observed = runtimeRelay(runtime, relayOptions(counter)).then(
    relay => ({ kind: "returned", relay }) as const,
    error => ({ kind: "rejected", error }) as const,
  );
  try {
    await runtime.dispose();
    const outcome = await observed;
    if (outcome.kind === "returned" && outcome.relay) await refusedRelayConnect(outcome.relay);
    expect(counter.calls).toBe(0);
    expect(outcome.kind).toBe("rejected");
  } finally {
    const outcome = await observed;
    if (outcome.kind === "returned") await outcome.relay?.close();
    await runtime.dispose();
  }
});

test("closed runtime relay rejects stale connect before token acquisition", async () => {
  const runtime = processRuntimeFixture({});
  const counter = { calls: 0 };
  const relay = await runtimeRelay(runtime, relayOptions(counter));
  if (!relay) throw new Error("Expected the configured runtime relay");
  try {
    await relay.close();
    await relay.close();
    expect(await refusedRelayConnect(relay)).toBeInstanceOf(Error);
    expect(counter.calls).toBe(0);
  } finally {
    await relay.close();
    await runtime.dispose();
  }
});

import { NetHost as BunNetHost } from "../src/net/host";

function fetchThroughSlot(host: BunNetHost, meta: object): number {
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  new Uint8Array(memory.buffer).set(bytes, 16);
  const fetchSlot = host.slots().fetch;
  if (!fetchSlot) throw new Error("missing fetch slot");
  return fetchSlot(16, bytes.length, 0, 0);
}

test("rewritePackageUrl only intercepts package-policy requests and ignores ordinary npm-accept fetches", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const ring = createRing();
  const seen: Array<{ url: string; kind: string }> = [];
  const fetched: Array<{ url: string; headers: Headers }> = [];
  const tarball = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.23/waffle-base-0.0.23.tgz";
  const proxy = `https://sprockt.invalid/api/tarball-proxy?url=${encodeURIComponent(tarball)}`;
  const helper = createBunNetworkHelper(await runtime.network(), ring, {
    rewritePackageUrl(request) {
      seen.push(request);
      return request.url.startsWith("https://github.com/") ? proxy : undefined;
    },
    fetch: async (url, init) => {
      fetched.push({ url, headers: new Headers(init.headers) });
      if (url === proxy) return new Response("proxied-tarball");
      if (url === "https://registry.invalid/evlog") return new Response("{\"name\":\"evlog\"}");
      return new Response("ordinary-fetch");
    },
  });
  const bunHost = new BunNetHost(ring, req => dispatchBunNetwork(helper, { type: "net", req }), undefined, { shared: true });
  const runtimeHost = bunHost.runtime;
  try {
    const readHandle = async (handle: number) => {
      for (let turn = 0; turn < 100 && runtimeHost.fetchHead(handle) === AGAIN; turn++) await Bun.sleep(1);
      const data = runtimeHost.read(handle, 1024);
      runtimeHost.close(handle);
      return data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data);
    };
    const pkgTarball = fetchThroughSlot(bunHost, {
      url: tarball, method: "GET", credentialPolicy: "package",
      headers: [["accept", "application/vnd.bun.install-tarball"]],
    });
    expect(await readHandle(pkgTarball)).toBe("proxied-tarball");
    const pkgMeta = fetchThroughSlot(bunHost, {
      url: "https://registry.invalid/evlog", method: "GET", credentialPolicy: "package",
      headers: [["accept", "application/vnd.npm.install-v1+json; q=1.0"]],
    });
    expect(await readHandle(pkgMeta)).toBe("{\"name\":\"evlog\"}");
    // Ordinary user fetch requesting npm abbreviated metadata must bypass rewritePackageUrl.
    const userMeta = runtimeHost.fetch(JSON.stringify({
      url: "https://github.com/user-npm-meta", method: "GET",
      headers: [["accept", "application/vnd.npm.install-v1+json"]],
    }), null);
    expect(await readHandle(userMeta)).toBe("ordinary-fetch");
    const userTarball = runtimeHost.fetch(JSON.stringify({
      url: "https://github.com/user-tarball", method: "GET",
      headers: [["accept", "application/vnd.bun.install-tarball"]],
    }), null);
    expect(await readHandle(userTarball)).toBe("ordinary-fetch");
    // Package-policy fetches to a guest loopback registry must carry no internal headers.
    const listener = runtimeHost.listen("127.0.0.1", 0);
    const loopbackPort = runtimeHost.localPort(listener);
    const loopbackFetch = fetchThroughSlot(bunHost, {
      url: `http://127.0.0.1:${loopbackPort}/evlog`, method: "GET", credentialPolicy: "package",
      headers: [["accept", "application/vnd.npm.install-v1+json"]],
    });
    let accepted = AGAIN;
    for (let turn = 0; turn < 100 && accepted === AGAIN; turn++) {
      await Bun.sleep(1);
      accepted = runtimeHost.accept(listener);
    }
    expect(accepted).toBeGreaterThan(0);
    let requestText = "";
    for (let turn = 0; turn < 100 && !requestText.includes("\r\n\r\n"); turn++) {
      const chunk = runtimeHost.read(accepted, 2048);
      if (chunk instanceof Uint8Array) requestText += new TextDecoder().decode(chunk);
      else await Bun.sleep(1);
    }
    expect(requestText.toLowerCase()).not.toContain("x-bun-wasm-package-policy");
    runtimeHost.write(accepted, new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
    runtimeHost.close(accepted);
    runtimeHost.close(listener);
    expect(await readHandle(loopbackFetch)).toBe("ok");
    expect(seen).toEqual([
      { url: tarball, kind: "tarball" },
      { url: "https://registry.invalid/evlog", kind: "metadata" },
    ]);
    expect(fetched.map(call => call.url)).toEqual([
      proxy,
      "https://registry.invalid/evlog",
      "https://github.com/user-npm-meta",
      "https://github.com/user-tarball",
    ]);
    for (const call of fetched) expect(call.headers.has("x-bun-wasm-package-policy")).toBe(false);
  } finally {
    helper.dispose();
    await runtime.dispose();
  }
});

test("rewritePackageUrl resolves the route before Cache Storage lookup and isolates distinct proxies", async () => {
  const runtime = processRuntimeFixture({ directoryHandle: socketDirectoryFixture });
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const stored = new Map<string, string>();
  const fetched: string[] = [];
  const rewriteCalls: string[] = [];
  const tarball = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.23/waffle-base-0.0.23.tgz";
  const proxyA = `https://proxy-a.invalid/api/tarball-proxy?url=${encodeURIComponent(tarball)}`;
  const proxyB = `https://proxy-b.invalid/api/tarball-proxy?url=${encodeURIComponent(tarball)}`;
  const cache = {
    async open() {
      return {
        async match(url: string) {
          const hit = stored.get(url);
          return hit === undefined ? undefined : new Response(hit);
        },
        async put(url: string, response: Response) {
          stored.set(url, await response.text());
        },
      };
    },
  };
  const makeClient = async (proxyUrl: string, body: string) => {
    const ring = createRing();
    const helper = createBunNetworkHelper(await runtime.network(), ring, {
      rewritePackageUrl: ({ url, kind }) => {
        rewriteCalls.push(`${proxyUrl}:${kind}`);
        return kind === "tarball" && url === tarball ? proxyUrl : undefined;
      },
      fetch: async url => {
        fetched.push(url);
        return new Response(body);
      },
    });
    const bunHost = new BunNetHost(ring, req => dispatchBunNetwork(helper, { type: "net", req }), undefined, { shared: true });
    const runtimeHost = bunHost.runtime;
    const runFetch = async () => {
      const handle = fetchThroughSlot(bunHost, {
        url: tarball, method: "GET", credentialPolicy: "package",
        headers: [["accept", "application/vnd.bun.install-tarball"]],
      });
      for (let turn = 0; turn < 100 && runtimeHost.fetchHead(handle) === AGAIN; turn++) await Bun.sleep(1);
      const chunks: number[] = [];
      for (let turn = 0; turn < 100; turn++) {
        const piece = runtimeHost.read(handle, 1024);
        if (piece === 0) break;
        if (piece === AGAIN) { await Bun.sleep(1); continue; }
        if (piece instanceof Uint8Array) chunks.push(...piece);
      }
      runtimeHost.close(handle);
      return new TextDecoder().decode(new Uint8Array(chunks));
    };
    return { helper, runFetch };
  };
  const clientA = await makeClient(proxyA, "cached-via-proxy-a");
  const clientB = await makeClient(proxyB, "cached-via-proxy-b");
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: cache });
    expect(await clientA.runFetch()).toBe("cached-via-proxy-a");
    for (let turn = 0; turn < 50 && !stored.has(proxyA); turn++) await Bun.sleep(2);
    expect(stored.has(proxyA)).toBe(true);
    expect(stored.has(tarball)).toBe(false);
    // Same proxy hits warm cache without a second network request.
    expect(await clientA.runFetch()).toBe("cached-via-proxy-a");
    // Distinct proxy must invoke its own rewriter and never receive proxy A's cached bytes.
    expect(await clientB.runFetch()).toBe("cached-via-proxy-b");
    for (let turn = 0; turn < 50 && !stored.has(proxyB); turn++) await Bun.sleep(2);
    expect(stored.has(proxyB)).toBe(true);
    expect(fetched).toEqual([proxyA, proxyB]);
    expect(rewriteCalls).toEqual([`${proxyA}:tarball`, `${proxyA}:tarball`, `${proxyB}:tarball`]);
  } finally {
    clientA.helper.dispose();
    clientB.helper.dispose();
    await runtime.dispose();
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});
