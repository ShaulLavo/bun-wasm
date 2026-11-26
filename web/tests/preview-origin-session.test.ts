import { expect, test } from "bun:test";
import type { PreviewHostExchange, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";
import { CookieJar } from "../src/preview-origin/cookie-jar";
import { PortSession } from "../src/preview-origin/port-session";
import type { SessionReply } from "../src/preview-origin/protocol";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.sprockt.dev`;
const GRANT = Object.freeze({ owner: "owner-1", port: 5173, origin: ORIGIN, capability: "capability-that-never-leaves-the-ide" });
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

function setup(sockets?: Set<{ close(): void }>, socketSilenceMs?: number) {
  const dispatched: { open: PreviewHostOpen; exchange: PreviewHostExchange }[] = [];
  const jar = new CookieJar(new URL(ORIGIN).hostname, true);
  let cookieChanges = 0;
  let attached = 0;
  let navigations = 0;
  const channel = new MessageChannel();
  const session = new PortSession(channel.port1, {
    relay: {
      authorization: GRANT,
      origin: ORIGIN,
      dispatch: (open, exchange) => { dispatched.push({ open, exchange }); return new Promise(() => {}); },
    },
    jar,
    sockets,
    socketSilenceMs,
    cookiesChanged: () => { cookieChanges++; },
    attached: () => { attached++; },
    navigationServed: () => { navigations++; },
  });
  const replies: SessionReply[] = [];
  const waiters = new Set<() => void>();
  const remote = channel.port2;
  remote.onmessage = (event: MessageEvent<SessionReply>) => {
    replies.push(event.data);
    for (const wake of Array.from(waiters)) wake();
  };
  const until = async (ready: () => boolean) => {
    while (!ready()) await new Promise<void>(resolve => { const wake = () => { waiters.delete(wake); resolve(); }; waiters.add(wake); });
  };
  const settle = () => Bun.sleep(10);
  return { session, jar, dispatched, replies, remote, until, settle, counts: () => ({ cookieChanges, attached, navigations }) };
}

/** A page's end of one socket, opened through the session, with what the guest and the page each saw. */
async function openSocket(f: ReturnType<typeof setup>) {
  const channel = new MessageChannel();
  const page: string[] = [];
  const guest: string[] = [];
  channel.port1.onmessage = (event: MessageEvent<{ type: string; chunk?: Uint8Array }>) => { page.push(event.data.chunk ? text(event.data.chunk) : event.data.type); };
  f.remote.postMessage({ t: "socket" }, [channel.port2]);
  channel.port1.postMessage({ type: "open", url: `${ORIGIN}/hmr`, method: "GET", headers: [] });
  const at = f.dispatched.length;
  while (f.dispatched.length === at) await Bun.sleep(1);
  const { exchange } = f.dispatched[at]!;
  exchange.onmessage = (message) => { guest.push(message.type === "data" ? text(message.chunk) : message.type); };
  exchange.postMessage({ type: "accepted" });
  return { port: channel.port1, page, guest, exchange };
}

/** Waits for an outcome. The test's own timeout is the hang cap. */
async function eventually(ready: () => boolean): Promise<void> {
  while (!ready()) await Bun.sleep(2);
}

const open = (id: number, path: string, extra: Record<string, unknown> = {}) => ({ t: "open", id, url: `${ORIGIN}${path}`, method: "GET", headers: [["accept", "*/*"]], body: null, credentials: "include", ...extra });

test("the handler supplies its own grant and ignores any the preview origin sends", async () => {
  const f = setup();
  f.remote.postMessage(open(1, "/api", { authorization: { owner: "other", port: 1, origin: "https://evil.dev", capability: "guess" }, port: 9999, route: "ws-other", headers: [["cookie", "forged=1"], ["host", "evil.dev"], ["accept", "*/*"]] }));
  await f.settle();
  expect(f.dispatched.length).toBe(1);
  expect(f.dispatched[0]!.open).toEqual({ type: "http", authorization: GRANT, url: `${ORIGIN}/api`, method: "GET", headers: [["accept", "*/*"]], body: null });
  f.session.close();
});

test("a request for another origin, a malformed message or a reused id never reaches Waffle", async () => {
  const f = setup();
  f.remote.postMessage(open(1, "", { url: "https://bun.sprockt.dev/secret" }));
  f.remote.postMessage(open(2, "", { url: `https://${"b".repeat(52)}-5173-pv.sprockt.dev/` }));
  f.remote.postMessage({ t: "open", id: 3 });
  f.remote.postMessage({ t: "bind", port: 3000 });
  f.remote.postMessage("open");
  await f.until(() => f.replies.filter(reply => reply.t === "finish").length === 2);
  expect(f.dispatched).toEqual([]);
  expect(f.replies).toEqual([
    { t: "output", id: 1, output: { type: "error", message: "Preview request left its origin" } }, { t: "finish", id: 1 },
    { t: "output", id: 2, output: { type: "error", message: "Preview request left its origin" } }, { t: "finish", id: 2 },
  ]);
  f.remote.postMessage(open(7, "/a"));
  f.remote.postMessage(open(7, "/b"));
  await f.until(() => f.replies.some(reply => reply.t === "finish" && reply.id === 7));
  expect(f.dispatched.map(item => new URL(item.open.url).pathname)).toEqual(["/a"]);
  f.session.close();
});

test("Set-Cookie stops at the IDE: the jar keeps it, the page gets only what script may see, and later requests carry it", async () => {
  const f = setup();
  f.remote.postMessage({ t: "attached" });
  await f.until(() => f.replies.length === 1);
  expect(f.replies[0]).toEqual({ t: "cookies", cookies: [] });
  expect(f.counts().attached).toBe(1);

  f.remote.postMessage(open(1, "/login"));
  await f.settle();
  f.dispatched[0]!.exchange.postMessage({ type: "accepted" });
  f.dispatched[0]!.exchange.postMessage({ type: "head", status: 200, statusText: "OK", headers: [["Set-Cookie", "sid=secret; Path=/; HttpOnly"], ["set-cookie", "theme=dark; Path=/"], ["content-type", "text/html"]] });
  const body = bytes("<p>hi</p>");
  f.dispatched[0]!.exchange.postMessage({ type: "data", chunk: body }, [body.buffer]);
  f.dispatched[0]!.exchange.close();
  await f.until(() => f.replies.some(reply => reply.t === "finish"));
  const head = f.replies.find((reply): reply is Extract<SessionReply, { t: "output" }> => reply.t === "output" && reply.output.type === "head")!;
  expect(head.output).toEqual({ type: "head", status: 200, statusText: "OK", headers: [["content-type", "text/html"]] });
  expect(head.cookies).toEqual([{ name: "theme", value: "dark", path: "/", expires: null, secure: false }]);
  expect(JSON.stringify(f.replies)).not.toContain("secret");
  expect(f.counts().cookieChanges).toBe(1);

  f.remote.postMessage(open(2, "/api"));
  f.remote.postMessage(open(3, "/api", { credentials: "omit" }));
  await f.settle();
  expect(f.dispatched[1]!.open.headers).toEqual([["accept", "*/*"], ["cookie", "sid=secret; theme=dark"]]);
  expect(f.dispatched[2]!.open.headers).toEqual([["accept", "*/*"]]);
  // A response to a request without credentials sets nothing, and an unchanged jar sends no cookies again.
  f.dispatched[2]!.exchange.postMessage({ type: "head", status: 200, statusText: "OK", headers: [["set-cookie", "ignored=1"]] });
  f.dispatched[1]!.exchange.postMessage({ type: "head", status: 200, statusText: "OK", headers: [] });
  await f.until(() => f.replies.filter(reply => reply.t === "output" && reply.output.type === "head").length === 3);
  expect(f.jar.header("/")).toBe("sid=secret; theme=dark");
  expect(f.replies.filter(reply => reply.t === "output" && reply.cookies !== undefined).length).toBe(1);
  f.session.close();
});

test("a script cookie write is applied in order and cannot touch an HttpOnly cookie", async () => {
  const f = setup();
  f.jar.setFromHeader("sid=secret; Path=/; HttpOnly", "/");
  f.remote.postMessage({ t: "cookie", id: 1, line: "client=1; Path=/", url: `${ORIGIN}/page` });
  f.remote.postMessage(open(2, "/after-write"));
  f.remote.postMessage({ t: "cookie", id: 3, line: "sid=stolen; Path=/", url: `${ORIGIN}/page` });
  f.remote.postMessage({ t: "cookie", id: 4, line: "elsewhere=1", url: "https://evil.dev/" });
  await f.until(() => f.replies.filter(reply => reply.t === "cookies").length === 3);
  expect(f.dispatched[0]!.open.headers).toEqual([["accept", "*/*"], ["cookie", "sid=secret; client=1"]]);
  const visible = [{ name: "client", value: "1", path: "/", expires: null, secure: false }];
  expect(f.replies).toEqual([{ t: "cookies", id: 1, cookies: visible }, { t: "cookies", id: 3, cookies: visible }, { t: "cookies", id: 4, cookies: visible }]);
  expect(f.jar.header("/")).toBe("sid=secret; client=1");
  f.session.close();
});

test("a socket opens with the preview origin as its Origin, the jar's cookies, and a 101 head without Set-Cookie", async () => {
  const f = setup();
  f.jar.setFromHeader("sid=secret; Path=/; HttpOnly", "/");
  const socket = new MessageChannel();
  const page: PreviewHostOutput[] = [];
  socket.port1.onmessage = (event: MessageEvent<PreviewHostOutput>) => { page.push(event.data); };
  f.remote.postMessage({ t: "socket" }, [socket.port2]);
  socket.port1.postMessage({ type: "data", chunk: bytes("before open") });
  socket.port1.postMessage({ type: "open", url: `wss://${new URL(ORIGIN).host}/hmr?token=1`, method: "GET", headers: [["Upgrade", "websocket"], ["Origin", "https://evil.dev"], ["Host", "evil.dev"], ["Cookie", "forged=1"], ["Sec-WebSocket-Key", "abc"]] });
  await f.settle();
  expect(f.dispatched.length).toBe(1);
  expect(f.dispatched[0]!.open).toEqual({
    type: "socket", authorization: GRANT, url: `${ORIGIN}/hmr?token=1`, method: "GET",
    headers: [["Upgrade", "websocket"], ["Sec-WebSocket-Key", "abc"], ["Origin", ORIGIN], ["Cookie", "sid=secret"]],
  });
  const { exchange } = f.dispatched[0]!;
  exchange.postMessage({ type: "accepted" });
  exchange.postMessage({ type: "data", chunk: bytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSet-Cookie: ws=1; Path=/; Http") });
  exchange.postMessage({ type: "data", chunk: bytes("Only\r\nSec-WebSocket-Accept: xyz\r\n\r\nFRAME") });
  exchange.postMessage({ type: "data", chunk: bytes("MORE") });
  const received: Uint8Array[] = [];
  exchange.onmessage = message => { if (message.type === "data") received.push(message.chunk); };
  socket.port1.postMessage({ type: "data", chunk: bytes("client frame") });
  socket.port1.postMessage({ type: "grant" });
  await f.settle();
  expect(page.map(output => (output.type === "data" ? text(output.chunk) : output.type))).toEqual([
    "accepted", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: xyz\r\n\r\nFRAME", "MORE",
  ]);
  expect(received.map(text)).toEqual(["client frame"]);
  expect(f.jar.header("/")).toBe("sid=secret; ws=1");
  expect(f.counts().cookieChanges).toBe(1);
  f.session.close();
  socket.port1.close();
});

test("a listener's sockets outlive the service worker's port and end with the listener", async () => {
  const sockets = new Set<{ close(): void }>();
  const f = setup(sockets);
  f.remote.postMessage({ t: "attached" });
  const socket = new MessageChannel();
  const page: string[] = [];
  socket.port1.onmessage = (event: MessageEvent<PreviewHostOutput>) => { page.push(event.data.type); };
  f.remote.postMessage({ t: "socket" }, [socket.port2]);
  socket.port1.postMessage({ type: "open", url: `${ORIGIN}/hmr`, method: "GET", headers: [] });
  await f.settle();
  const received: string[] = [];
  f.dispatched[0]!.exchange.onmessage = message => { received.push(message.type === "data" ? text(message.chunk) : message.type); };
  f.dispatched[0]!.exchange.postMessage({ type: "accepted" });
  // The worker restarted: its port is replaced, the page's socket is not touched.
  f.session.close();
  socket.port1.postMessage({ type: "data", chunk: bytes("still open") });
  await f.settle();
  expect(received).toEqual(["still open"]);
  expect(sockets.size).toBe(1);
  // The dev server stopped: its listener closes every socket.
  for (const open of Array.from(sockets)) open.close();
  await f.settle();
  expect(received).toEqual(["still open", "end"]);
  expect(sockets.size).toBe(0);
  expect(page).toEqual(["accepted"]);
  socket.port1.close();
  f.remote.close();
});

test("an upgrade response head larger than the cap fails the socket, and none of it reaches the page", async () => {
  const sockets = new Set<{ close(): void }>();
  const f = setup(sockets);
  const socket = await openSocket(f);
  // Set-Cookie sits in a head that crosses 64 KiB before it ends: nothing may be forwarded unfiltered.
  socket.exchange.postMessage({ type: "data", chunk: bytes(`HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: sid=secret; Path=/; HttpOnly\r\nX-Pad: ${"a".repeat(40_000)}`) });
  await f.settle();
  expect(socket.page).toEqual(["accepted"]);
  socket.exchange.postMessage({ type: "data", chunk: bytes("b".repeat(40_000)) });
  socket.exchange.postMessage({ type: "data", chunk: bytes("\r\nSet-Cookie: late=secret\r\n\r\nFRAME") });
  await eventually(() => socket.page.includes("error"));
  await f.settle();
  expect(socket.page).toEqual(["accepted", "error"]);
  expect(socket.guest).toEqual(["end"]);
  expect(sockets.size).toBe(0);
  // The refused head set nothing.
  expect(f.jar.header("/")).toBeNull();
  expect(f.counts().cookieChanges).toBe(0);
  socket.port.close();
  f.session.close();
});

test("a head that ends in the chunk that crosses the cap is still filtered before it is forwarded", async () => {
  const f = setup();
  const socket = await openSocket(f);
  socket.exchange.postMessage({ type: "data", chunk: bytes(`HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${"a".repeat(60_000)}`) });
  socket.exchange.postMessage({ type: "data", chunk: bytes(`\r\nX-More: ${"b".repeat(8_000)}\r\nSet-Cookie: sid=secret; Path=/; HttpOnly\r\n\r\nFRAME`) });
  await eventually(() => socket.page.length === 2);
  expect(socket.page[1]).toEndWith("\r\n\r\nFRAME");
  expect(socket.page[1]).not.toContain("secret");
  expect(f.jar.header("/")).toBe("sid=secret");
  socket.port.close();
  f.session.close();
});

test("a page that vanished without a word lets go of its guest connection", async () => {
  const sockets = new Set<{ close(): void }>();
  const f = setup(sockets);
  const socket = await openSocket(f);
  // The page's document is gone: its port closes and nothing was sent first.
  socket.port.close();
  await eventually(() => socket.guest.includes("end"));
  expect(socket.guest).toEqual(["end"]);
  expect(sockets.size).toBe(0);
  f.session.close();
});

test("a socket answers pings, and one that hears nothing from its page for the silence cap is closed", async () => {
  const sockets = new Set<{ close(): void }>();
  const f = setup(sockets, 40);
  const socket = await openSocket(f);
  socket.port.postMessage({ type: "ping" });
  await eventually(() => socket.page.includes("pong"));
  expect(socket.guest).toEqual([]);
  // No browser reports this port as closed, and the page stopped pinging: the cap ends the connection.
  await eventually(() => sockets.size === 0);
  expect(socket.guest).toEqual(["end"]);
  socket.port.close();
  f.session.close();
});

test("a socket whose page keeps pinging stays open past the silence cap", async () => {
  const sockets = new Set<{ close(): void }>();
  const f = setup(sockets, 1_000);
  const socket = await openSocket(f);
  const started = Date.now();
  while (Date.now() - started < 1_300) {
    socket.port.postMessage({ type: "ping" });
    await Bun.sleep(50);
  }
  expect(sockets.size).toBe(1);
  expect(socket.guest).toEqual([]);
  socket.port.postMessage({ type: "data", chunk: bytes("still open") });
  await eventually(() => socket.guest.length === 1);
  expect(socket.guest).toEqual(["still open"]);
  for (const open of Array.from(sockets)) open.close();
  socket.port.close();
  f.session.close();
});

test("a malformed request is refused by id: missing or unknown credentials, and header pairs that are not headers", async () => {
  const f = setup();
  f.jar.setFromHeader("sid=secret; Path=/; HttpOnly", "/");
  f.remote.postMessage(open(1, "/a", { credentials: undefined }));
  f.remote.postMessage(open(2, "/b", { credentials: "same-origin" }));
  f.remote.postMessage(open(3, "/c", { headers: [["x-a", "1\r\nx-injected: 1"]] }));
  f.remote.postMessage(open(4, "/d", { headers: [["x a", "1"]] }));
  f.remote.postMessage(open(5, "/e", { headers: [["x-a"]] }));
  await f.until(() => f.replies.filter(reply => reply.t === "finish").length === 5);
  expect(f.dispatched).toEqual([]);
  expect(f.replies).toEqual([1, 2, 3, 4, 5].flatMap((id): SessionReply[] => [
    { t: "output", id, output: { type: "error", message: "Malformed preview request" } }, { t: "finish", id },
  ]));
  // The exchange ids are free again, and a well-formed request without credentials carries no cookie.
  f.remote.postMessage(open(1, "/again", { credentials: "omit" }));
  await f.settle();
  expect(f.dispatched.map(item => item.open.headers)).toEqual([[["accept", "*/*"]]]);
  f.session.close();
});

test("the session reports each head it sends for a frame navigation, and for nothing else", async () => {
  const f = setup();
  f.remote.postMessage(open(1, "/page", { headers: [["sec-fetch-mode", "navigate"]] }));
  f.remote.postMessage(open(2, "/api", { headers: [["sec-fetch-mode", "cors"]] }));
  f.remote.postMessage(open(3, "/slow", { headers: [["Sec-Fetch-Mode", "navigate"]] }));
  await f.settle();
  expect(f.counts().navigations).toBe(0);
  f.dispatched[1]!.exchange.postMessage({ type: "head", status: 200, statusText: "OK", headers: [] });
  f.dispatched[0]!.exchange.postMessage({ type: "accepted" });
  expect(f.counts().navigations).toBe(0);
  f.dispatched[0]!.exchange.postMessage({ type: "head", status: 200, statusText: "OK", headers: [["content-type", "text/plain"]] });
  expect(f.counts().navigations).toBe(1);
  // A navigation the server never answers counts for nothing.
  f.dispatched[2]!.exchange.postMessage({ type: "error", message: "refused" });
  expect(f.counts().navigations).toBe(1);
  f.session.close();
});

test("a session closed before the service worker confirmed its port lets go of it only on confirmation", async () => {
  // WebKit terminates the page's process when a port is closed while its other end is in transit.
  const f = setup();
  f.remote.postMessage(open(1, "/early"));
  await f.settle();
  f.session.close();
  f.remote.postMessage(open(2, "/after-close"));
  await f.settle();
  expect(f.replies).toEqual([]);
  expect(f.dispatched.length).toBe(1);
  f.remote.postMessage({ t: "attached" });
  await f.until(() => f.replies.length === 1);
  expect(f.replies).toEqual([{ t: "detach" }]);
  expect(f.counts().attached).toBe(0);
  f.remote.close();
});

test("closing the session ends what is in flight and tells the service worker", async () => {
  const f = setup();
  f.remote.postMessage({ t: "attached" });
  f.remote.postMessage(open(1, "/stream"));
  await f.settle();
  const inputs: string[] = [];
  f.dispatched[0]!.exchange.onmessage = message => { inputs.push(message.type); };
  f.remote.postMessage({ t: "input", id: 1, input: { type: "pull" } });
  f.remote.postMessage({ t: "ping", n: 4 });
  await f.until(() => f.replies.some(reply => reply.t === "pong"));
  f.session.close();
  await f.until(() => f.replies.some(reply => reply.t === "detach"));
  expect(inputs).toEqual(["pull", "end"]);
  expect(f.replies).toEqual([{ t: "cookies", cookies: [] }, { t: "pong", n: 4 }, { t: "detach" }]);
  f.remote.close();
});
