import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PreviewServer } from "waffle/browser/preview";
import { previewOrigin, previewOriginId, RELAY_MESSAGE, RELAY_PATH, type SessionReply } from "../src/preview-origin/protocol";
import { RootPreviews } from "../src/preview-origin/root-previews";

const IDE = "https://bun.sprockt.dev";
const config = { domain: "sprockt.dev" };

/** A relay frame as the IDE page sees it: a window that records what is posted to it. */
class FakeFrame {
  readonly posted: { message: unknown; origin: string; ports: MessagePort[] }[] = [];
  readonly contentWindow = { postMessage: (message: unknown, origin: string, ports: MessagePort[] = []) => { this.posted.push({ message, origin, ports }); } };
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  src = "";
  title = "";
  tabIndex = 0;
  removed = false;
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  remove(): void { this.removed = true; }
}

let frames: FakeFrame[] = [];
let listeners = new Set<(event: MessageEvent) => void>();
const saved = { window: Reflect.get(globalThis, "window"), document: Reflect.get(globalThis, "document") };

beforeEach(() => {
  frames = [];
  listeners = new Set();
  Object.assign(globalThis, {
    window: {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => { listeners.delete(listener); },
    },
    document: {
      createElement: () => { const frame = new FakeFrame(); frames.push(frame); return frame; },
      body: { appendChild: () => {} },
    },
  });
});
afterEach(() => { Object.assign(globalThis, saved); });

function deliver(frame: FakeFrame | { contentWindow: unknown }, origin: string, data: unknown): void {
  for (const listener of Array.from(listeners)) listener({ data, origin, source: frame.contentWindow, ports: [] } as unknown as MessageEvent);
}

const server = (): PreviewServer => ({ request: () => false, connect: () => null });
const settle = () => Bun.sleep(10);

/** Plays the service worker: confirms a port and collects what the IDE sends on it. */
function acknowledge(port: MessagePort): SessionReply[] {
  const replies: SessionReply[] = [];
  port.onmessage = (event: MessageEvent<SessionReply>) => { replies.push(event.data); };
  port.postMessage({ t: "attached" });
  return replies;
}

async function setup(identity = "workspace-1") {
  const previews = new RootPreviews({ config, identity, ideOrigin: IDE, frameBase: `${IDE}/sandbox/`, relayTimeoutMs: 300 });
  const origin = previewOrigin(config, await previewOriginId(IDE, identity), 5173);
  return { previews, origin };
}

test("a listener becomes ready only after its relay frame is up and the service worker confirmed the port", async () => {
  const { previews, origin } = await setup();
  const token = previews.registerListener(5173, server());
  const registered = previews.waitUntilRegistered(5173, token);
  await settle();
  expect(frames.length).toBe(1);
  expect(frames[0]!.src).toBe(`${origin}${RELAY_PATH}`);
  expect(frames[0]!.style.display).toBe("none");
  expect(frames[0]!.posted).toEqual([]);
  expect(previews.isListenerReady(5173, token)).toBe(false);
  expect(previews.serves(5173)).toBe(false);

  deliver(frames[0]!, origin, { type: RELAY_MESSAGE, event: "ready" });
  const [attach] = frames[0]!.posted;
  expect(attach?.message).toEqual({ type: RELAY_MESSAGE, event: "attach" });
  // The port goes to the preview origin only.
  expect(attach?.origin).toBe(origin);
  expect(attach?.ports.length).toBe(1);
  expect(previews.isListenerReady(5173, token)).toBe(false);

  const replies = acknowledge(attach!.ports[0]!);
  expect(await registered).toBe("ready");
  expect(previews.isListenerReady(5173, token)).toBe(true);
  expect(previews.serves(5173)).toBe(true);
  expect(await previews.ready).toBe("ready");
  await settle();
  expect(replies).toEqual([{ t: "cookies", cookies: [] }]);
  expect(previews.url(5173, "/dashboard?tab=1")).toBe(`${origin}/dashboard?tab=1`);
  const link = new URL(previews.linkUrl(5173, "/dashboard"));
  expect(link.origin + link.pathname).toBe(`${IDE}/sandbox/preview-frame.html`);
  expect(link.searchParams.get("url")).toBe(`${origin}/dashboard`);
  // A mounted preview URL published by another tab stays its own link.
  expect(previews.linkFor(`${IDE}/__preview/r/ws-x/5173/`)).toBe(`${IDE}/__preview/r/ws-x/5173/`);
  await previews.dispose();
  expect(frames[0]!.removed).toBe(true);
  expect(listeners.size).toBe(0);
});

test("a relay message counts only from that origin's own frame", async () => {
  const { previews, origin } = await setup();
  previews.register(5173, server());
  await settle();
  deliver({ contentWindow: {} }, origin, { type: RELAY_MESSAGE, event: "ready" });
  deliver(frames[0]!, "https://evil.dev", { type: RELAY_MESSAGE, event: "ready" });
  deliver(frames[0]!, origin, { type: "something-else", event: "ready" });
  deliver(frames[0]!, origin, { type: RELAY_MESSAGE, event: "attach" });
  expect(frames[0]!.posted).toEqual([]);
  await previews.dispose();
});

test("a restarted service worker gets a new port and the old one is revoked", async () => {
  const { previews, origin } = await setup();
  const token = previews.registerListener(5173, server());
  await settle();
  deliver(frames[0]!, origin, { type: RELAY_MESSAGE, event: "ready" });
  const first = acknowledge(frames[0]!.posted[0]!.ports[0]!);
  expect(await previews.waitUntilRegistered(5173, token)).toBe("ready");
  deliver(frames[0]!, origin, { type: RELAY_MESSAGE, event: "need-port" });
  expect(frames[0]!.posted.length).toBe(2);
  const second = acknowledge(frames[0]!.posted[1]!.ports[0]!);
  await settle();
  expect(first).toEqual([{ t: "cookies", cookies: [] }, { t: "detach" }]);
  expect(second).toEqual([{ t: "cookies", cookies: [] }]);
  expect(previews.isListenerReady(5173, token)).toBe(true);
  // A forced drop behaves the same from the service worker's side.
  previews.dropAttachment(5173);
  await settle();
  expect(second.at(-1)).toEqual({ t: "detach" });
  await previews.dispose();
});

test("a dev server that restarts keeps its relay frame and gets a new port with a new grant", async () => {
  const { previews, origin } = await setup();
  const firstServer = server();
  const firstToken = previews.registerListener(5173, firstServer);
  await settle();
  deliver(frames[0]!, origin, { type: RELAY_MESSAGE, event: "ready" });
  const first = acknowledge(frames[0]!.posted[0]!.ports[0]!);
  expect(await previews.waitUntilRegistered(5173, firstToken)).toBe("ready");

  previews.unregisterListener(5173, firstToken);
  await settle();
  expect(first.at(-1)).toEqual({ t: "detach" });
  expect(previews.serves(5173)).toBe(false);
  expect(previews.hasListener(5173, firstToken)).toBe(false);
  expect(() => previews.url(5173)).toThrow();
  // With no listener, a request for a port gets none.
  deliver(frames[0]!, origin, { type: RELAY_MESSAGE, event: "need-port" });
  expect(frames[0]!.posted.length).toBe(1);

  const secondToken = previews.registerListener(5173, server());
  await settle();
  expect(frames.length).toBe(1);
  expect(frames[0]!.removed).toBe(false);
  expect(frames[0]!.posted.length).toBe(2);
  acknowledge(frames[0]!.posted[1]!.ports[0]!);
  expect(await previews.waitUntilRegistered(5173, secondToken)).toBe("ready");
  expect(await previews.waitUntilRegistered(5173, firstToken)).toBe("failed");
  await previews.dispose();
});

test("each port and each workspace identity gets its own origin, and a relay that never answers fails the listener", async () => {
  const { previews, origin } = await setup();
  const other = await setup("workspace-2");
  expect(other.origin).not.toBe(origin);
  const a = previews.registerListener(5173, server());
  const b = previews.registerListener(3000, server());
  await settle();
  expect(frames.map(frame => frame.src).sort()).toEqual([`${origin}${RELAY_PATH}`, `${origin.replace("-5173-pv", "-3000-pv")}${RELAY_PATH}`].sort());
  expect(await previews.waitUntilRegistered(5173, a)).toBe("failed");
  expect(await previews.waitUntilRegistered(3000, b)).toBe("failed");
  expect(await previews.ready).toBe("failed");
  await previews.dispose();
  await other.previews.dispose();
});

test("an identity that cannot be read fails the listener and is asked for again next time", async () => {
  let reads = 0;
  const previews = new RootPreviews({ config, identity: async () => { if (++reads === 1) throw new Error("workspace not ready"); return "workspace-1"; }, ideOrigin: IDE, frameBase: `${IDE}/`, relayTimeoutMs: 300 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failed = previews.registerListener(5173, server());
    expect(await previews.waitUntilRegistered(5173, failed)).toBe("failed");
    previews.unregisterListener(5173, failed);
    previews.registerListener(5173, server());
    await settle();
    expect(reads).toBe(2);
    expect(frames.length).toBe(1);
  } finally {
    console.warn = warn;
    await previews.dispose();
  }
});
