import { expect, test } from "bun:test";
import {
  COOKIE_PATH, IDE_ONLY_MESSAGE, RELAY_PATH, SHIM_PATH, SW_ATTACH, SW_COOKIES, SW_COOKIES_ACK, SW_NEED_PORT, SW_PATH, SW_SHIM, SW_SOCKET,
  type SessionReply, type SessionRequest,
} from "../src/preview-origin/protocol";
import { insertAfterDoctype } from "../src/preview-html";
import { createPreviewOriginServiceWorker, withoutFrameAncestors, type OriginClient } from "../src/preview-origin/sw-core";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.sprockt.dev`;
const IDE = "https://bun.sprockt.dev";

/** The IDE page's end of an attached port: it records requests and answers them by hand. */
class Ide {
  readonly requests: SessionRequest[] = [];
  readonly ports: MessagePort[] = [];
  private readonly waiters = new Set<() => void>();
  /** `answer`: what a live listener (`cookies`) or a replaced one (`detach`) says once the worker holds the port. */
  constructor(readonly port: MessagePort, answer: "cookies" | "detach" = "cookies") {
    port.onmessage = (event: MessageEvent<SessionRequest>) => {
      this.requests.push(event.data);
      this.ports.push(...event.ports);
      if (event.data.t === "attached") this.reply(answer === "cookies" ? { t: "cookies", cookies: [] } : { t: "detach" });
      for (const wake of Array.from(this.waiters)) wake();
    };
  }
  reply(message: SessionReply, transfer: Transferable[] = []): void { this.port.postMessage(message, transfer); }
  async next<T extends SessionRequest["t"]>(kind: T, skip = 0): Promise<Extract<SessionRequest, { t: T }>> {
    for (;;) {
      const found = this.requests.filter((request): request is Extract<SessionRequest, { t: T }> => request.t === kind)[skip];
      if (found) return found;
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
      });
    }
  }
}

interface FakeClient extends OriginClient { readonly messages: unknown[] }

function setup(options: { relays?: number; ideOrigins?: string[]; attachWaitMs?: number } = {}) {
  const clients = new Map<string, FakeClient>();
  const client = (id: string, url: string): FakeClient => {
    const item: FakeClient = { id, url, messages: [], postMessage(message) { item.messages.push(message); } };
    clients.set(id, item);
    return item;
  };
  const relays = Array.from({ length: options.relays ?? 1 }, (_, index) => client(`relay-${index}`, `${ORIGIN}${RELAY_PATH}`));
  const page = client("page", `${ORIGIN}/`);
  const worker = createPreviewOriginServiceWorker({
    origin: ORIGIN,
    clients: { get: async id => clients.get(id), matchAll: async () => Array.from(clients.values()) },
    shimScript: "/* shim */",
    ideOrigins: options.ideOrigins ?? [IDE],
    userAgent: "TestAgent/1",
    attachWaitMs: options.attachWaitMs ?? 2_000,
    pingTimeoutMs: 200,
    cookieAckMs: 200,
  });
  const attach = (relay = relays[0]!, answer: "cookies" | "detach" = "cookies"): Ide => {
    const channel = new MessageChannel();
    const ide = new Ide(channel.port1, answer);
    worker.message({ data: { type: SW_ATTACH }, ports: [channel.port2], source: relay });
    return ide;
  };
  return { worker, clients, relays, page, attach };
}

interface FakeRequest { method?: string; headers?: [string, string][]; mode?: string; destination?: string; credentials?: string; referrer?: string; body?: string; signal?: AbortSignal }

function request(path: string, init: FakeRequest = {}): Request {
  const body = init.body === undefined ? null : new TextEncoder().encode(init.body);
  return {
    url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
    method: init.method ?? "GET",
    headers: new Headers(init.headers ?? []),
    mode: init.mode ?? "cors",
    destination: init.destination ?? "",
    credentials: init.credentials ?? "same-origin",
    referrer: init.referrer ?? "",
    signal: init.signal ?? new AbortController().signal,
    arrayBuffer: async () => body!.buffer,
  } as unknown as Request;
}

const bytes = (value: string) => new TextEncoder().encode(value);

/** Answers like Waffle's dispatcher: one body chunk per pull credit, which arrives once the page reads. */
function respond(ide: Ide, id: number, headers: [string, string][], body: string[], status = 200): void {
  const credits = ide.requests.filter(item => item.t === "input").length;
  void (async () => {
    ide.reply({ t: "output", id, output: { type: "accepted" } });
    ide.reply({ t: "output", id, output: { type: "head", status, statusText: "OK", headers } });
    for (const [index, chunk] of body.entries()) {
      const data = bytes(chunk);
      ide.reply({ t: "output", id, output: { type: "data", chunk: data } }, [data.buffer]);
      await ide.next("input", credits + index);
    }
    ide.reply({ t: "output", id, output: { type: "end" } });
    ide.reply({ t: "finish", id });
  })();
}

test("only the relay page may attach a port, and the worker confirms it on the port itself", async () => {
  const { worker, page, attach } = setup();
  const stray = new MessageChannel();
  worker.message({ data: { type: SW_ATTACH }, ports: [stray.port2], source: page });
  worker.message({ data: { type: SW_ATTACH }, ports: [stray.port2], source: null });
  expect(worker.attachments.length).toBe(0);
  const ide = attach();
  expect(await ide.next("attached")).toEqual({ t: "attached" });
  expect(worker.attachments.length).toBe(1);
  stray.port1.close();
  ide.port.close();
});

test("a request crosses unchanged, with the headers a service worker cannot see restored and none it must not send", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  const pending = worker.fetch(request("/api/items?page=2", {
    method: "POST", body: "payload", referrer: `${ORIGIN}/list`, destination: "", mode: "cors",
    headers: [["content-type", "text/plain"], ["cookie", "forged=1"], ["host", "evil.dev"], ["accept-encoding", "br"]],
  }), "page")!;
  const open = await ide.next("open");
  expect(open.url).toBe(`${ORIGIN}/api/items?page=2`);
  expect(open.method).toBe("POST");
  expect(open.credentials).toBe("include");
  expect(new TextDecoder().decode(open.body!)).toBe("payload");
  expect(Object.fromEntries(open.headers)).toEqual({
    "content-type": "text/plain", origin: ORIGIN, referer: `${ORIGIN}/list`, "user-agent": "TestAgent/1", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors",
  });
  respond(ide, open.id, [["content-type", "application/json"], ["set-cookie", "leak=1"], ["x-app", "yes"], ["connection", "close"]], ['{"ok":', "true}"]);
  const response = await pending;
  expect(response.status).toBe(200);
  expect(response.headers.get("x-app")).toBe("yes");
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("connection")).toBe(false);
  expect(await response.text()).toBe('{"ok":true}');
  ide.port.close();
});

test("a framed HTML navigation gets the shim, the cookies script may see, and the headers its embedder needs", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  await ide.next("attached");
  ide.reply({ t: "cookies", cookies: [{ name: "theme", value: 'da"rk<', path: "/", expires: null, secure: false }] });
  const pending = worker.fetch(request("/dashboard", { mode: "navigate", destination: "iframe", credentials: "include" }), "")!;
  const open = await ide.next("open");
  expect(Object.fromEntries(open.headers)["sec-fetch-dest"]).toBe("iframe");
  respond(ide, open.id, [
    ["content-type", "text/html; charset=utf-8"], ["x-frame-options", "DENY"],
    ["content-security-policy", "default-src 'self'; frame-ancestors 'none'"], ["cross-origin-resource-policy", "same-origin"],
  ], ["<!DOCTYPE html><html><head><script>first()</script>", "</head></html>"]);
  const response = await pending;
  const text = await response.text();
  expect(text).toStartWith(`<!DOCTYPE html><script src="${SHIM_PATH}" data-bunwasm-preview="shim" data-cookies="[{&quot;name&quot;:&quot;theme&quot;,&quot;value&quot;:&quot;da\\&quot;rk&lt;&quot;`);
  expect(text).toEndWith("<html><head><script>first()</script></head></html>");
  expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  expect(response.headers.has("x-frame-options")).toBe(false);
  expect(response.headers.get("content-security-policy")).toBe(`default-src 'self', frame-ancestors ${IDE}`);
  ide.port.close();
});

test("a top-level visit is told to use the IDE and reaches nothing, even with a live IDE tab attached", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  await ide.next("attached");
  const target = new URL(COOKIE_PATH, ORIGIN);
  target.searchParams.set("line", "planted=1; Path=/");
  for (const path of ["/", "/account/secret?x=1", SHIM_PATH, target.href]) {
    for (const method of ["GET", "POST", "HEAD"]) {
      const response = await worker.fetch(request(path, { method, mode: "navigate", destination: "document", credentials: "include", body: method === "POST" ? "a=1" : undefined }), "")!;
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toStartWith("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      const text = await response.text();
      expect(text).toBe(method === "HEAD" ? "" : `<!doctype html><meta charset="utf-8"><title>Preview</title><body><p role="status">${IDE_ONLY_MESSAGE}</p></body>`);
    }
  }
  // A frame of the same pages is the app's, and is served.
  const framed = worker.fetch(request("/account/secret?x=1", { mode: "navigate", destination: "iframe" }), "")!;
  const open = await ide.next("open");
  respond(ide, open.id, [["content-type", "text/html"]], ["<!doctype html><p>framed</p>"]);
  expect(await (await framed).text()).toContain("<p>framed</p>");
  // Nothing of the top-level visits crossed: no request, no cookie write.
  expect(ide.requests.filter(item => item.t === "open").length).toBe(1);
  expect(ide.requests.some(item => item.t === "cookie")).toBe(false);
  ide.port.close();
});

test("a fetched HTML fragment keeps the app's own headers and bytes", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  const fragment = worker.fetch(request("/fragment"), "page")!;
  const open = await ide.next("open");
  ide.reply({ t: "output", id: open.id, output: { type: "head", status: 200, statusText: "OK", headers: [["content-type", "text/html"], ["x-frame-options", "DENY"]] } });
  const data = bytes("<p>fragment</p>");
  ide.reply({ t: "output", id: open.id, output: { type: "data", chunk: data } }, [data.buffer]);
  ide.reply({ t: "output", id: open.id, output: { type: "end" } });
  const response = await fragment;
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.has("cross-origin-embedder-policy")).toBe(false);
  expect(await response.text()).toBe("<p>fragment</p>");
  ide.port.close();
});

test("a request aborted while it waits for an attachment opens nothing and holds no exchange slot", async () => {
  const { worker, relays, attach } = setup();
  const aborted = new AbortController();
  const upload = new AbortController();
  // Both wait: the worker has no port yet and asks the relay frame for one.
  const cancelled = worker.fetch(request("/cancelled", { signal: aborted.signal }), "page")!;
  const cancelledUpload = worker.fetch(request("/cancelled-upload", { method: "POST", body: "payload", signal: upload.signal }), "page")!;
  const kept = worker.fetch(request("/kept"), "page")!;
  await Bun.sleep(20);
  expect(relays[0]!.messages).toEqual([{ type: SW_NEED_PORT }]);
  aborted.abort();
  upload.abort();
  const ide = attach();
  const open = await ide.next("open");
  expect(open.url).toBe(`${ORIGIN}/kept`);
  respond(ide, open.id, [], ["kept"]);
  expect(await (await kept).text()).toBe("kept");
  expect((await cancelled).status).toBe(503);
  expect((await cancelledUpload).status).toBe(503);
  await Bun.sleep(20);
  // The guest saw one connection: no `open` for the cancelled requests, and no `end` for an exchange that never was.
  expect(ide.requests.filter(item => item.t === "open").map(item => new URL(item.url).pathname)).toEqual(["/kept"]);
  expect(ide.requests.filter(item => item.t === "input" && item.input.type === "end")).toEqual([]);
  expect(worker.attachments.length).toBe(1);
  expect(worker.attachments[0]!.exchanges.size).toBe(0);
  ide.port.close();
});

test("a request aborted after it opened ends its exchange once and frees the slot", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  const controller = new AbortController();
  const pending = worker.fetch(request("/slow", { signal: controller.signal }), "page")!;
  const open = await ide.next("open");
  expect(worker.attachments[0]!.exchanges.size).toBe(1);
  controller.abort();
  expect((await pending).status).toBe(502);
  expect(await ide.next("input")).toEqual({ t: "input", id: open.id, input: { type: "end" } });
  expect(worker.attachments[0]!.exchanges.size).toBe(0);
  ide.port.close();
});

test("the shim tag passes every policy of the response or is left out, names the IDE's wrapper page, and a document that is not HTML crosses untouched", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  await ide.next("attached");
  const wrapper = `${IDE}/sandbox/preview-frame.html?preview-origin=https%3A%2F%2Fsprockt.dev&url=${encodeURIComponent(`${ORIGIN}/`)}&x="<`;
  ide.reply({ t: "cookies", cookies: [], wrapper });
  // What the shim tag carries: a nonce, none, or no tag at all (null) when a policy would block it.
  const policies: [string | string[], string | null][] = [
    ["script-src 'nonce-r4nd0m+/=' 'strict-dynamic'; object-src 'none'", ` nonce="r4nd0m+/="`],
    ["default-src 'none'; script-src-elem 'nonce-abc_-123'; script-src 'nonce-other'", ` nonce="abc_-123"`],
    ["default-src 'nonce-fallback'", ` nonce="fallback"`],
    ["script-src 'self'; style-src 'nonce-style'", ""],
    // Layered policies: a proxy's same-origin policy with its own nonce, and the app's nonce-only policy.
    ["script-src 'self' 'nonce-proxy', script-src 'nonce-app' 'strict-dynamic'", ` nonce="app"`],
    [["script-src 'nonce-app'", "script-src 'self' 'nonce-proxy'; img-src *"], ` nonce="app"`],
    ["script-src 'nonce-one' 'nonce-both', default-src 'nonce-both' 'nonce-two'", ` nonce="both"`],
    // No one tag passes these: none is written, and nobody's policy is widened.
    ["script-src 'nonce-proxy', script-src 'nonce-app'", null],
    ["script-src 'none'", null],
    ["script-src 'sha256-RFWPLDbv2BY+rCkDzsE+0fr8ylGr2R2faWMhq4lfEQc='", null],
    ["script-src 'nonce-bad\"><script>x()</script>'", null],
  ];
  for (const [index, [policy, attribute]] of policies.entries()) {
    const pending = worker.fetch(request(`/page-${index}`, { mode: "navigate", destination: "iframe" }), "")!;
    const open = await ide.next("open", index);
    const policyHeaders = [policy].flat().map((value): [string, string] => ["content-security-policy", value]);
    respond(ide, open.id, policyHeaders.concat([["content-type", "text/html"]]), ["<!doctype html><p>page</p>"]);
    const response = await pending;
    const text = await response.text();
    // The app's policies cross as they came, apart from frame-ancestors.
    expect(response.headers.get("content-security-policy")).toBe(`${[policy].flat().join(", ")}, frame-ancestors ${IDE}`);
    if (attribute === null) expect(text).toBe("<!doctype html><p>page</p>");
    else expect(text).toStartWith(`<!doctype html><script src="${SHIM_PATH}"${attribute} data-bunwasm-preview="shim" data-wrapper="${IDE}/sandbox/preview-frame.html?preview-origin=https%3A%2F%2Fsprockt.dev&amp;url=`);
    if (attribute !== null) expect(text).toContain(`&amp;x=&quot;&lt;" data-cookies="[]"></script><p>page</p>`);
  }
  // Plain text has nowhere to put a script: it is the server's bytes, and the frame's embedder settles it (RootPreviews.watchFrame).
  const plain = worker.fetch(request("/notes.txt", { mode: "navigate", destination: "iframe" }), "")!;
  const open = await ide.next("open", policies.length);
  respond(ide, open.id, [["content-type", "text/plain; charset=utf-8"]], ["<!doctype html> is not markup here"]);
  const response = await plain;
  expect(await response.text()).toBe("<!doctype html> is not markup here");
  expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  ide.port.close();
});

test("a worker that restarted without its port asks the relay frames and serves once one arrives", async () => {
  const { worker, relays, attach } = setup({ relays: 2 });
  const pending = worker.fetch(request("/after-restart"), "page")!;
  await Bun.sleep(20);
  for (const relay of relays) expect(relay.messages).toEqual([{ type: SW_NEED_PORT }]);
  const ide = attach(relays[1]);
  const open = await ide.next("open");
  expect(open.url).toBe(`${ORIGIN}/after-restart`);
  respond(ide, open.id, [["content-type", "text/plain"]], ["recovered"]);
  expect(await (await pending).text()).toBe("recovered");
  ide.port.close();
});

test("with no IDE tab to ask, the worker answers for itself and never falls back to the network", async () => {
  const { worker, clients } = setup({ relays: 0 });
  const api = await worker.fetch(request("/api"), "page")!;
  expect(api.status).toBe(503);
  expect(api.headers.get("content-type")).toStartWith("text/plain");
  const framed = await worker.fetch(request("/", { mode: "navigate", destination: "iframe" }), "")!;
  expect(framed.status).toBe(503);
  expect(framed.headers.get("content-security-policy")).toContain(`frame-ancestors ${IDE}`);
  expect(framed.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  const html = await framed.text();
  expect(html).toContain("not connected to its IDE tab");
  expect(html).toContain('"transient":true');
  expect(clients.size).toBe(1);
});

test("an attachment whose tab is gone is dropped, its requests fail, and the next tab's port takes over", async () => {
  const { worker, clients, relays, attach } = setup({ relays: 2, attachWaitMs: 500 });
  const first = attach(relays[0]);
  const hanging = worker.fetch(request("/slow"), "page")!;
  await first.next("open");
  clients.delete(relays[0]!.id);
  await Bun.sleep(300);
  const next = worker.fetch(request("/next"), "page")!;
  expect((await hanging).status).toBe(502);
  await Bun.sleep(20);
  expect(relays[1]!.messages).toEqual([{ type: SW_NEED_PORT }]);
  const second = attach(relays[1]);
  const open = await second.next("open");
  respond(second, open.id, [], ["from the new owner"]);
  expect(await (await next).text()).toBe("from the new owner");
  first.port.close();
  second.port.close();
});

test("a port whose listener was replaced on its way is never used, whichever port arrives first", async () => {
  // A dev server that restarts as it starts sends two ports within a millisecond.
  for (const order of ["live-first", "stale-first"] as const) {
    const { worker, relays, attach } = setup();
    const first = attach(relays[0], order === "live-first" ? "cookies" : "detach");
    const pending = order === "stale-first" ? worker.fetch(request("/early"), "page")! : undefined;
    const second = attach(relays[0], order === "live-first" ? "detach" : "cookies");
    const [live, stale] = order === "live-first" ? [first, second] : [second, first];
    await stale.next("attached");
    const answered = pending ?? worker.fetch(request("/late"), "page")!;
    const open = await live.next("open");
    respond(live, open.id, [], [order]);
    expect(await (await answered).text()).toBe(order);
    expect(stale.requests).toEqual([{ t: "attached" }]);
    expect(worker.attachments.length).toBe(1);
    // The relay frame was not asked for another port: one was already on its way.
    expect(relays[0]!.messages).toEqual([]);
    first.port.close();
    second.port.close();
  }
});

test("a cookie write keeps its place: the IDE receives it before any later request", async () => {
  const { worker, attach } = setup();
  const ide = attach();
  const slow = worker.fetch(request("/upload", { method: "POST", body: "x".repeat(1000) }), "page")!;
  const target = new URL(COOKIE_PATH, ORIGIN);
  target.searchParams.set("line", "client=1; Path=/");
  target.searchParams.set("url", `${ORIGIN}/page`);
  const write = worker.fetch(request(target.href), "page")!;
  const later = worker.fetch(request("/api/after"), "page")!;
  const cookie = await ide.next("cookie");
  await ide.next("open", 1);
  expect(ide.requests.filter(item => item.t !== "attached").map(item => (item.t === "open" ? new URL(item.url).pathname : item.t))).toEqual(["/upload", "cookie", "/api/after"]);
  expect(cookie).toMatchObject({ line: "client=1; Path=/", url: `${ORIGIN}/page` });
  ide.reply({ t: "cookies", id: cookie.id, cookies: [{ name: "client", value: "1", path: "/", expires: null, secure: false }] });
  expect(await (await write).json()).toEqual([{ name: "client", value: "1", path: "/", expires: null, secure: false }]);
  for (const [index, pending] of [slow, later].entries()) {
    const open = await ide.next("open", index);
    respond(ide, open.id, [], []);
    expect((await pending).status).toBe(200);
  }
  ide.port.close();
});

test("cookies a response changed reach the requesting page before the response does", async () => {
  const { worker, page, attach } = setup();
  const ide = attach();
  worker.message({ data: { type: SW_SHIM }, ports: [], source: page });
  let settled = false;
  const pending = worker.fetch(request("/login", { method: "POST", body: "" }), "page")!.then(response => { settled = true; return response; });
  const open = await ide.next("open");
  const cookies = [{ name: "theme", value: "dark", path: "/", expires: null, secure: false }];
  ide.reply({ t: "output", id: open.id, output: { type: "head", status: 204, statusText: "No Content", headers: [] }, cookies });
  ide.reply({ t: "output", id: open.id, output: { type: "end" } });
  await Bun.sleep(30);
  const delivered = page.messages.find((message): message is { type: string; cookies: unknown; ack: number } => (message as { type?: unknown }).type === SW_COOKIES);
  expect(delivered?.cookies).toEqual(cookies);
  expect(settled).toBe(false);
  worker.message({ data: { type: SW_COOKIES_ACK, ack: delivered!.ack }, ports: [], source: page });
  expect((await pending).status).toBe(204);
  ide.port.close();
});

test("a page's socket port goes straight to the IDE, and only the worker's own paths skip the relay", async () => {
  const { worker, page, attach } = setup();
  const ide = attach();
  const channel = new MessageChannel();
  worker.message({ data: { type: SW_SOCKET }, ports: [channel.port2], source: page });
  await ide.next("socket");
  expect(ide.ports.length).toBe(1);
  expect(worker.fetch(request(SW_PATH), "page")).toBeUndefined();
  expect(worker.fetch(request(RELAY_PATH), "")).toBeUndefined();
  expect(worker.fetch(request("https://cdn.example/lib.js"), "page")).toBeUndefined();
  const shim = await worker.fetch(request(SHIM_PATH), "page")!;
  expect(await shim.text()).toBe("/* shim */");
  expect(shim.headers.get("content-type")).toStartWith("text/javascript");
  channel.port1.close();
  ide.port.close();
});

test("frame-ancestors is removed from every policy and nothing else", () => {
  expect(withoutFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src *")).toBe("default-src 'self'; img-src *");
  expect(withoutFrameAncestors("frame-ancestors 'self', script-src 'self'")).toBe("script-src 'self'");
  expect(withoutFrameAncestors("FRAME-ANCESTORS https://a.test")).toBe("");
  expect(withoutFrameAncestors("frame-ancestors-like x; frame-src 'self'")).toBe("frame-ancestors-like x; frame-src 'self'");
});

test("the shim goes after the doctype even when the first chunk is one byte", async () => {
  const chunks = ["<", "!doctype html", ">", "<html></html>"].map(bytes);
  const source = new ReadableStream<Uint8Array>({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); } });
  expect(await new Response(insertAfterDoctype(source, "<script></script>")).text()).toBe("<!doctype html><script></script><html></html>");
  const bare = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes("<p>no doctype</p>")); controller.close(); } });
  expect(await new Response(insertAfterDoctype(bare, "<script></script>")).text()).toBe("<script></script><p>no doctype</p>");
});
