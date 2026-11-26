import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PreviewServer } from "waffle/browser/preview";
import { previewOrigin, previewOriginId, RELAY_INSPECT_QUERY, RELAY_MESSAGE, RELAY_PATH, type FrameDocument, type SessionReply } from "../src/preview-origin/protocol";
import { RootPreviews } from "../src/preview-origin/root-previews";

const IDE = "https://bun.sprockt.dev";
const config = { domain: "sprockt.dev" };

/** The windows of the page's frames, in document order, as `window.frames` lists them. */
let pageWindows: unknown[] = [];

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
  constructor() { pageWindows.push(this.contentWindow); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  remove(): void { this.removed = true; }
}

let frames: FakeFrame[] = [];
let listeners = new Set<(event: MessageEvent) => void>();
const saved = { window: Reflect.get(globalThis, "window"), document: Reflect.get(globalThis, "document") };

beforeEach(() => {
  frames = [];
  pageWindows = [];
  listeners = new Set();
  Object.assign(globalThis, {
    window: {
      get frames() { return pageWindows; },
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
  // The answer names the wrapper page too, for new tabs the app opens itself.
  expect(replies).toEqual([{ t: "cookies", cookies: [], wrapper: `${IDE}/sandbox/preview-frame.html?preview-origin=https%3A%2F%2Fsprockt.dev&url=${encodeURIComponent(`${origin}/`)}` }]);
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
  const attached: SessionReply = { t: "cookies", cookies: [], wrapper: previews.linkFor(`${origin}/`) };
  expect(first).toEqual([attached, { t: "detach" }]);
  expect(second).toEqual([attached]);
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

/** A preview frame as the IDE page sees it: an element of the page whose `load` event the test fires. */
class FakePreviewFrame {
  readonly contentWindow = {};
  private readonly loads = new Set<(event: Event) => void>();
  constructor(public src: string) { pageWindows.push(this.contentWindow); }
  addEventListener(type: string, listener: (event: Event) => void): void { if (type === "load") this.loads.add(listener); }
  removeEventListener(_type: string, listener: (event: Event) => void): void { this.loads.delete(listener); }
  get watched(): boolean { return this.loads.size > 0; }
  /** The browser finished loading whatever document the frame holds. */
  load(): void { for (const listener of Array.from(this.loads)) listener({ isTrusted: true } as Event); }
  /** Where the frame sits among the page's frames now. */
  get index(): number { return pageWindows.indexOf(this.contentWindow); }
  element(): HTMLIFrameElement { return this as unknown as HTMLIFrameElement; }
}

function watch(previews: RootPreviews, frame: FakePreviewFrame) {
  const events: string[] = [];
  const stop = previews.watchFrame(frame.element(), {
    loaded: (href) => { events.push(`loaded ${href}`); },
    failed: (transient) => { events.push(transient ? "failed, try again" : "failed"); },
  });
  return { events, stop };
}

interface Question { type: string; event: "inspect"; id: number; index: number }

/** The frame questions the IDE page has posted to a relay frame, oldest first. */
function questions(relay: FakeFrame): Question[] {
  return relay.posted.map(item => item.message as Question).filter(message => message.event === "inspect");
}

/** The relay page looked at the frame and says what it holds. The answer reaches the page in a later task. */
async function answer(relay: FakeFrame, origin: string, question: Question | undefined, document: FrameDocument): Promise<void> {
  if (!question) throw new Error("No frame question was asked");
  deliver(relay, origin, { type: RELAY_MESSAGE, event: "inspected", id: question.id, document });
  await settle();
}

test("a frame without the shim settles by its load event only when the origin's relay page finds the server's loaded document in that very frame", async () => {
  const { previews, origin } = await setup();
  previews.registerListener(5173, server());
  await settle();
  const relay = frames[0]!;

  // A frame is watched before it has an address, as the sandbox's is: its initial blank document asks nothing.
  const frame = new FakePreviewFrame("");
  const { events, stop } = watch(previews, frame);
  frame.load();
  deliver(relay, origin, { type: RELAY_MESSAGE, event: "ready" });
  expect(questions(relay)).toEqual([]);

  // Each load of a frame at a preview address is put to the relay page of that origin, about that frame.
  frame.src = `${origin}/notes.txt#top`;
  frame.load();
  expect(questions(relay)).toEqual([{ type: RELAY_MESSAGE, event: "inspect", id: 1, index: frame.index }]);
  expect(relay.posted.at(-1)?.origin).toBe(origin);
  // The cold-load page, an error page, a final document whose body is still arriving, a document of another origin: none settles.
  await answer(relay, origin, questions(relay).at(-1), "own");
  for (const provisional of ["own", "loading", "unreadable"] as const) {
    frame.load();
    await answer(relay, origin, questions(relay).at(-1), provisional);
  }
  expect(events).toEqual([]);
  // Plain text carries no shim. The relay page finds it loaded in the frame: that load settles it, once.
  frame.load();
  const settled = questions(relay).at(-1);
  await answer(relay, origin, settled, "server");
  await answer(relay, origin, settled, "server");
  expect(events).toEqual(["loaded null"]);

  // Only the relay frame of that origin is believed.
  frame.load();
  deliver({ contentWindow: {} }, origin, { type: RELAY_MESSAGE, event: "inspected", id: questions(relay).at(-1)!.id, document: "server" });
  deliver(relay, "https://evil.dev", { type: RELAY_MESSAGE, event: "inspected", id: questions(relay).at(-1)!.id, document: "server" });
  await settle();
  expect(events).toEqual(["loaded null"]);
  await answer(relay, origin, questions(relay).at(-1), "server");
  expect(events).toEqual(["loaded null", "loaded null"]);

  // Two frames at one address are asked about separately: one's document says nothing about the other.
  const twin = new FakePreviewFrame(`${origin}/notes.txt`);
  const other = watch(previews, twin);
  frame.load();
  twin.load();
  const [aboutFrame, aboutTwin] = questions(relay).slice(-2);
  expect([aboutFrame?.index, aboutTwin?.index]).toEqual([frame.index, twin.index]);
  await answer(relay, origin, aboutFrame, "server");
  expect(other.events).toEqual([]);
  await answer(relay, origin, aboutTwin, "own");
  expect(other.events).toEqual([]);
  expect(events.length).toBe(3);

  // A new address needs nothing forgotten: a redirect that never finished leaves no state behind.
  frame.src = `${origin}/old`;
  frame.src = `${origin}/plain`;
  frame.load();
  await answer(relay, origin, questions(relay).at(-1), "server");
  expect(events.length).toBe(4);

  // An answer about a frame that moved among the page's frames, or was sent to another origin meanwhile, is dropped.
  frame.load();
  pageWindows.splice(pageWindows.indexOf(twin.contentWindow), 0, {});
  frame.load();
  pageWindows.unshift({});
  await answer(relay, origin, questions(relay).at(-2), "server");
  await answer(relay, origin, questions(relay).at(-1), "server");
  frame.load();
  frame.src = `${origin.replace("-5173-pv", "-3000-pv")}/`;
  await answer(relay, origin, questions(relay).at(-1), "server");
  expect(events.length).toBe(4);

  // The page's own word, and the service worker's, still come first.
  frame.src = `${origin}/`;
  deliver(frame, origin, { type: "bunwasm-preview-frame", event: "commit", href: `${origin}/` });
  deliver(frame, origin, { type: "bunwasm-preview-frame", event: "load", href: `${origin}/` });
  deliver(frame, origin, { type: "bunwasm-preview-frame", event: "error", href: `${origin}/`, transient: true });
  deliver(frame, origin, { type: "bunwasm-preview-frame", event: "error", href: `${origin}/`, transient: false });
  deliver({ contentWindow: {} }, origin, { type: "bunwasm-preview-frame", event: "load", href: `${origin}/` });
  deliver(frame, "https://evil.dev", { type: "bunwasm-preview-frame", event: "load", href: "https://evil.dev/" });
  expect(events.slice(4)).toEqual([`loaded ${origin}/`, "failed, try again", "failed"]);

  // A stopped watch hears nothing more, not even the answer to a question it asked.
  frame.load();
  stop();
  expect(frame.watched).toBe(false);
  await answer(relay, origin, questions(relay).at(-1), "server");
  frame.load();
  deliver(frame, origin, { type: "bunwasm-preview-frame", event: "load", href: `${origin}/` });
  expect(events.length).toBe(7);
  other.stop();
  await previews.dispose();
});

test("a tab that only shows another tab's server mounts the relay page to look, and settles its frame the same way", async () => {
  const { previews, origin } = await setup();
  const frame = new FakePreviewFrame(`${origin}/notes.txt`);
  const { events, stop } = watch(previews, frame);
  expect(frames).toEqual([]);
  // The first load mounts the origin's relay page in its looking-only mode, hidden, and waits for it.
  frame.load();
  frame.load();
  expect(frames.length).toBe(1);
  const inspector = frames[0]!;
  expect(inspector.src).toBe(`${origin}${RELAY_PATH}${RELAY_INSPECT_QUERY}`);
  expect(inspector.style.display).toBe("none");
  expect(inspector.posted).toEqual([]);
  deliver(inspector, origin, { type: RELAY_MESSAGE, event: "ready" });
  // It is asked about the frame, and never handed a port.
  expect(inspector.posted.map(item => (item.message as Question).event)).toEqual(["inspect", "inspect"]);
  expect(inspector.posted.every(item => item.ports.length === 0)).toBe(true);
  const [first, second] = questions(inspector);
  // The cold-load page loaded first: it settles nothing, whatever arrives when.
  await answer(inspector, origin, first, "own");
  expect(events).toEqual([]);
  await answer(inspector, origin, second, "server");
  expect(events).toEqual(["loaded null"]);
  deliver(inspector, origin, { type: RELAY_MESSAGE, event: "need-port" });
  expect(questions(inspector).length).toBe(inspector.posted.length);

  // Another frame of that origin uses the same page. When this tab starts the server itself, the relay frame proper is mounted beside it.
  const twin = new FakePreviewFrame(`${origin}/other.txt`);
  const other = watch(previews, twin);
  twin.load();
  expect(frames.length).toBe(1);
  expect(questions(inspector).at(-1)?.index).toBe(twin.index);
  previews.registerListener(5173, server());
  await settle();
  expect(frames.map(item => item.src)).toEqual([`${origin}${RELAY_PATH}${RELAY_INSPECT_QUERY}`, `${origin}${RELAY_PATH}`]);
  stop();
  other.stop();
  await previews.dispose();
  expect(frames.every(item => item.removed)).toBe(true);
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
