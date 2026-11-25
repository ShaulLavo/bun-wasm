import { expect, test } from "bun:test";
import type { PreviewHostExchange, PreviewHostOpen, PreviewHostOutput } from "waffle/browser/preview-host";
import { CookieJar } from "../src/preview-origin/cookie-jar";
import { PortSession } from "../src/preview-origin/port-session";
import type { SessionReply } from "../src/preview-origin/protocol";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.sprockt.dev`;
const GRANT = Object.freeze({ owner: "owner-1", port: 5173, origin: ORIGIN, capability: "capability-that-never-leaves-the-ide" });
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

function setup() {
  const dispatched: { open: PreviewHostOpen; exchange: PreviewHostExchange }[] = [];
  const jar = new CookieJar(new URL(ORIGIN).hostname, true);
  let cookieChanges = 0;
  let attached = 0;
  const channel = new MessageChannel();
  const session = new PortSession(channel.port1, {
    relay: {
      authorization: GRANT,
      origin: ORIGIN,
      dispatch: (open, exchange) => { dispatched.push({ open, exchange }); return new Promise(() => {}); },
    },
    jar,
    cookiesChanged: () => { cookieChanges++; },
    attached: () => { attached++; },
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
  return { session, jar, dispatched, replies, remote, until, settle, counts: () => ({ cookieChanges, attached }) };
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

test("closing the session ends what is in flight and tells the service worker", async () => {
  const f = setup();
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
  expect(f.replies).toEqual([{ t: "pong", n: 4 }, { t: "detach" }]);
  f.remote.close();
});
