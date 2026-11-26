import { expect, test } from "bun:test";
import { createRoutedPreviewServiceWorker, UNROUTED_KEY, type RoutedPreviewClient } from "../src/sw-routing";
import { Previews } from "../src/preview";

function makeClient(
  id: string,
  url: string,
  onMessage: (data: any, ports: MessagePort[]) => void,
): RoutedPreviewClient {
  return {
    id,
    url,
    postMessage(message: unknown, transfer?: Transferable[]) {
      const ports = (transfer ?? []).filter((t): t is MessagePort => t instanceof MessagePort);
      onMessage(message, ports);
    },
  };
}

test("sw-routing isolates routes fail-closed, acks registrations, and injects routed socket shim attributes", async () => {
  const clients: RoutedPreviewClient[] = [];
  const sw = createRoutedPreviewServiceWorker({
    scope: "https://example.test/__preview/",
    clients: {
      async get(id) { return clients.find((c) => c.id === id); },
      async matchAll() { return clients; },
    },
    fetch: async () => new Response("network fallback", { status: 404 }),
    socketScriptPath: "/__preview-socket.js",
    headTimeoutMs: 200,
    hydrateTimeoutMs: 50,
    claimTimeoutMs: 150,
  });

  const makeResponder = (label: string) => (data: any, ports: MessagePort[]) => {
    if (data?.type !== "preview-request") return;
    const port = ports[0]!;
    port.postMessage({ type: "accepted" });
    port.postMessage({ type: "head", status: 200, statusText: "OK", headers: [["content-type", "text/html"]] });
    port.postMessage({ type: "data", chunk: new TextEncoder().encode(`<!doctype html><h1>${label}</h1>`) });
    port.postMessage({ type: "end" });
  };

  const clientA = makeClient("tab-a", "https://example.test/", makeResponder("workspace-a"));
  const clientB = makeClient("tab-b", "https://example.test/", makeResponder("playground-b"));
  clients.push(clientA, clientB);

  // Unregistered route must fail closed (502) without leaking to another client.
  const unregistered = (await sw.fetch(new Request("https://example.test/__preview/r/ws-a/5173/"), ""))!;
  expect(unregistered.status).toBe(502);

  // Register tab-a on ws-a:5173 and tab-b on pg-b:5173, verifying ack on MessagePort.
  const ackA = new MessageChannel();
  const ackAPromise = new Promise<any>((resolve) => { ackA.port1.onmessage = (e) => resolve(e.data); });
  sw.message({ data: { type: "preview-register", route: "ws-a", port: 5173 }, source: clientA, ports: [ackA.port2] });
  expect((await ackAPromise).type).toBe("preview-register-ack");
  ackA.port1.close();

  const ackB = new MessageChannel();
  const ackBPromise = new Promise<any>((resolve) => { ackB.port1.onmessage = (e) => resolve(e.data); });
  sw.message({ data: { type: "preview-register", route: "pg-b", port: 5173 }, source: clientB, ports: [ackB.port2] });
  expect((await ackBPromise).type).toBe("preview-register-ack");
  ackB.port1.close();

  const resA = (await sw.fetch(new Request("https://example.test/__preview/r/ws-a/5173/"), ""))!;
  expect(resA.status).toBe(200);
  const htmlA = await resA.text();
  expect(htmlA).toContain("<h1>workspace-a</h1>");
  expect(htmlA).toContain('data-bun-prefix="/__preview/r/ws-a/"');
  expect(htmlA).toContain('data-bun-route="ws-a"');

  const resB = (await sw.fetch(new Request("https://example.test/__preview/r/pg-b/5173/"), ""))!;
  expect(resB.status).toBe(200);
  const htmlB = await resB.text();
  expect(htmlB).toContain("<h1>playground-b</h1>");
  expect(htmlB).toContain('data-bun-prefix="/__preview/r/pg-b/"');
  expect(htmlB).toContain('data-bun-route="pg-b"');

  // Unrouted request still fails closed because neither tab registered UNROUTED_KEY.
  const resUnrouted = (await sw.fetch(new Request("https://example.test/__preview/5173/"), ""))!;
  expect(resUnrouted.status).toBe(502);
  expect(UNROUTED_KEY).toBe("__unrouted__");
});

test("sw-routing translates pre-head end and headTimer expiry into 502 and sends cancel on abort", async () => {
  let cancelCount = 0;
  let mode: "pre-head-end" | "hang-after-accepted" = "pre-head-end";
  const client = makeClient("tab-1", "https://example.test/", (data, ports) => {
    if (data?.type !== "preview-request") return;
    const port = ports[0]!;
    port.onmessage = (e) => {
      if (e.data?.type === "cancel") cancelCount++;
    };
    port.postMessage({ type: "accepted" });
    if (mode === "pre-head-end") {
      port.postMessage({ type: "end" });
    }
  });

  const sw = createRoutedPreviewServiceWorker({
    scope: "https://example.test/__preview/",
    clients: {
      async get(id) { return id === "tab-1" ? client : undefined; },
      async matchAll() { return [client]; },
    },
    fetch: async () => new Response("fallback", { status: 404 }),
    socketScriptPath: "/__preview-socket.js",
    headTimeoutMs: 60,
    hydrateTimeoutMs: 25,
    claimTimeoutMs: 100,
  });

  sw.message({ data: { type: "preview-register", route: "ws-1", port: 5173 }, source: client, ports: [] });

  // Pre-head end must settle immediately with 502 instead of hanging forever.
  const preHeadEndRes = (await sw.fetch(new Request("https://example.test/__preview/r/ws-1/5173/"), ""))!;
  expect(preHeadEndRes.status).toBe(502);

  // Accepted without head must fire headTimer, send cancel, and settle with 502.
  mode = "hang-after-accepted";
  const timeoutRes = (await sw.fetch(new Request("https://example.test/__preview/r/ws-1/5173/"), ""))!;
  expect(timeoutRes.status).toBe(502);
  await new Promise<void>((r) => setTimeout(r, 20));
  expect(cancelCount).toBeGreaterThanOrEqual(1);

  // Pre-aborted signal must fail closed without contacting client.
  const aborted = new AbortController();
  aborted.abort();
  const beforeCancels = cancelCount;
  const abortRes = (await sw.fetch(new Request("https://example.test/__preview/r/ws-1/5173/"), "", aborted.signal))!;
  expect(abortRes.status).toBe(502);
  expect(cancelCount).toBe(beforeCancels);
});

test("sw-routing recovers registrations via bounded ensureHydrated preview-sync after SW restart", async () => {
  const client = makeClient("tab-sync", "https://example.test/", (data, ports) => {
    if (data?.type === "preview-sync") {
      ports[0]?.postMessage({ type: "preview-sync-reply", route: "ws-restarted", ports: [5173] });
      return;
    }
    if (data?.type === "preview-request") {
      const port = ports[0]!;
      port.postMessage({ type: "accepted" });
      port.postMessage({ type: "head", status: 200, statusText: "OK", headers: [["content-type", "text/plain"]] });
      port.postMessage({ type: "data", chunk: new TextEncoder().encode("hydrated-ok") });
      port.postMessage({ type: "end" });
    }
  });

  const sw = createRoutedPreviewServiceWorker({
    scope: "https://example.test/__preview/",
    clients: {
      async get(id) { return id === "tab-sync" ? client : undefined; },
      async matchAll() { return [client]; },
    },
    fetch: async () => new Response("fallback", { status: 404 }),
    socketScriptPath: "/__preview-socket.js",
    hydrateTimeoutMs: 100,
    headTimeoutMs: 200,
  });

  const res = (await sw.fetch(new Request("https://example.test/__preview/r/ws-restarted/5173/"), ""))!;
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hydrated-ok");
});

test("Previews direct root-mode resolves ready immediately and formats routed URLs cleanly", async () => {
  const rootPreviews = new Previews({
    mode: "root",
    originForPort: (port) => `http://p${port}.127.0.0.1.nip.io:8080`,
  });
  expect(await rootPreviews.ready).toBe("ready");
  rootPreviews.dispose();

  const routed = new Previews({ baseURL: "https://bun.shaulavo.dev/", prefix: "__preview", route: "ws-demo" });
  expect(routed.url(5173, "/app?a=1")).toBe("https://bun.shaulavo.dev/__preview/r/ws-demo/5173/app?a=1");
  routed.dispose();
});
