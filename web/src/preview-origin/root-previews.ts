// Previews on their own origins: `<id>-<port>-pv.<domain>` for each listening port of a workspace.
// The app owns `/` there, with its own cookies and storage. This page mounts one hidden relay
// frame per origin and hands it a MessagePort bound to that port's one Waffle grant; the origin's
// service worker carries every request of the app over it (docs/preview-origins.md).
import type { PreviewServer } from "waffle/browser/preview";
import type { PreviewHostRelay } from "waffle/browser/preview-host";
import { Previews, type PreviewState } from "../preview.js";
import { CookieJar } from "./cookie-jar.js";
import { frameIndex, type FrameWatch } from "./frame-watch.js";
import { PortSession } from "./port-session.js";
import {
  frameMessage, isPreviewOrigin, loopbackHost, previewFrameLink, previewOrigin, previewOriginId,
  RELAY_INSPECT_QUERY, RELAY_MESSAGE, RELAY_PATH, relayMessage,
  type FrameDocument, type FrameMessage, type PreviewOriginConfig, type RelayMessage,
} from "./protocol.js";

export type { FrameWatch } from "./frame-watch.js";

export interface RootPreviewsOptions {
  config: PreviewOriginConfig;
  /**
   * The workspace's immutable identity. Every tab of a workspace must supply the same value, and a
   * deleted and recreated workspace a new one, so that it starts with fresh origins and cookies.
   */
  identity: string | (() => Promise<string>);
  /** Keeps each origin's cookies in this page's localStorage, for a workspace that outlives its tabs. */
  persistCookies?: boolean;
  /** Defaults to this page. */
  ideOrigin?: string;
  /** Where the built new-tab wrapper page (`preview-frame.html`) lives. Defaults to this page's directory. */
  frameBase?: string;
  /**
   * An IDE with its own wrapper page (it calls `showPreviewFrame`) returns that page's URL for a
   * preview URL. The page takes the preview it shows in its `url` query parameter, as
   * `showPreviewFrame` reads it: previews build their own new-tab links from one such URL.
   */
  frameLink?(url: string): string;
  /** A hang cap for the relay frame and its service worker, never a speed limit. */
  relayTimeoutMs?: number;
}

interface Listening {
  readonly port: number;
  readonly server: PreviewServer;
  readonly token: symbol;
  readonly lifetime: AbortController;
  readonly ready: ReturnType<typeof Promise.withResolvers<PreviewState>>;
  /** Open WebSockets of this listener. They outlive any one port to the service worker. */
  readonly sockets: Set<{ close(): void }>;
  state: "starting" | "ready" | "failed";
  origin?: string;
  relay?: PreviewHostRelay;
  jar?: CookieJar;
  session?: PortSession;
  timer?: ReturnType<typeof setTimeout>;
}

/** The hidden frame of one preview origin. It holds no capability, so it outlives listener generations. */
interface RelayFrame {
  readonly frame: HTMLIFrameElement;
  /** The frame registered its service worker and listens for ports. */
  ready: boolean;
  /** Questions about this page's frames that wait for the frame to be ready. */
  readonly waiting: (() => void)[];
}

const COOKIE_KEY = "bunwasm-preview-cookies:";
const COOKIE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Jars of workspaces nobody opened for a month are dropped. */
function sweepCookies(store: Storage, now: number): void {
  const keys = Array.from({ length: store.length }, (_, index) => store.key(index)).filter((key): key is string => key?.startsWith(COOKIE_KEY) === true);
  for (const key of keys) {
    const saved = readStored(store, key)?.saved;
    if (typeof saved !== "number" || now - saved > COOKIE_KEEP_MS) store.removeItem(key);
  }
}

function readStored(store: Storage, key: string): { saved?: unknown; cookies?: unknown } | null {
  try {
    const value: unknown = JSON.parse(store.getItem(key) ?? "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export class RootPreviews extends Previews {
  private readonly listening = new Map<number, Listening>();
  /** By preview origin. */
  private readonly relays = new Map<string, RelayFrame>();
  private readonly origins: Map<number, string>;
  private readonly config: PreviewOriginConfig;
  private readonly identity: RootPreviewsOptions["identity"];
  private readonly ideOrigin: string;
  private readonly frameBase: string;
  private readonly frameLink: RootPreviewsOptions["frameLink"];
  private readonly relayTimeoutMs: number;
  private readonly cookieStore: Storage | null;
  /**
   * By preview origin: the relay page mounted only to look at frames, in a tab that shows a
   * preview whose server another tab runs. It gets no port.
   */
  private readonly inspectors = new Map<string, RelayFrame>();
  /** Questions to relay pages about this page's frames, by id, until they are answered. */
  private readonly inspections = new Map<number, (document: FrameDocument) => void>();
  private nextInspection = 1;
  private originId: Promise<string> | undefined;
  private rootDisposed = false;

  private readonly onWindowMessage = (event: MessageEvent<unknown>) => {
    const message = relayMessage(event.data);
    if (!message) return;
    // The frame and its origin identify the grant; nothing in the message does.
    const relay = this.relays.get(event.origin);
    const helper = [relay, this.inspectors.get(event.origin)].find(item => item?.frame.contentWindow === event.source);
    if (!helper) return;
    if (message.event === "inspected") {
      const answer = this.inspections.get(message.id);
      this.inspections.delete(message.id);
      answer?.(message.document);
      return;
    }
    if (message.event !== "ready" && message.event !== "need-port") return;
    helper.ready = true;
    for (const ask of helper.waiting.splice(0)) ask();
    const entry = helper === relay ? this.listenerAt(event.origin) : undefined;
    if (entry) this.attach(entry);
  };

  constructor(options: RootPreviewsOptions) {
    const origins = new Map<number, string>();
    super({
      mode: "root",
      originForPort(port) {
        const origin = origins.get(port);
        if (!origin) throw new Error("No allocated preview origin");
        return origin;
      },
    });
    this.origins = origins;
    this.config = options.config;
    this.identity = options.identity;
    this.ideOrigin = options.ideOrigin ?? location.origin;
    this.frameBase = options.frameBase ?? location.href;
    this.frameLink = options.frameLink;
    this.relayTimeoutMs = options.relayTimeoutMs ?? 60_000;
    this.cookieStore = options.persistCookies ? storage() : null;
    if (this.cookieStore) sweepCookies(this.cookieStore, Date.now());
    window.addEventListener("message", this.onWindowMessage);
  }

  /**
   * The link for a new tab: an IDE-origin page that frames the preview (preview-origin/frame-page.ts).
   * It also serves a preview URL that another tab of this workspace published.
   */
  override linkFor(url: string): string {
    if (!isPreviewOrigin(new URL(url).origin, this.config)) return url;
    return this.frameLink?.(url) ?? previewFrameLink(url, this.frameBase, this.config);
  }

  /**
   * Reports what the preview document in `frame` says about itself. A cross-origin frame's `load`
   * event fires for error pages too, so the page's own word is the proof that it committed.
   */
  observeFrame(frame: HTMLIFrameElement, listener: (message: FrameMessage) => void): () => void {
    const handler = (event: MessageEvent<unknown>) => {
      if (event.source !== frame.contentWindow || !isPreviewOrigin(event.origin, this.config)) return;
      const message = frameMessage(event.data);
      if (message) listener(message);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }

  private listenerAt(origin: string): Listening | undefined {
    return Array.from(this.listening.values()).find(item => item.origin === origin);
  }

  /** The preview origin `frame` was sent to (its `src`), or null while it has no preview address. */
  private previewOriginOf(frame: HTMLIFrameElement): string | null {
    if (!frame.src) return null;
    try {
      const { origin } = new URL(frame.src);
      return isPreviewOrigin(origin, this.config) ? origin : null;
    } catch {
      return null;
    }
  }

  /**
   * What `frame` holds, as a page of `origin` sees it: this tab's relay frame of that origin, or
   * the relay page mounted here for looking only. The answer is about this frame alone, and
   * "unreadable" when the page's frames changed while the question travelled.
   */
  private inspect(frame: HTMLIFrameElement, origin: string): Promise<FrameDocument> {
    const index = frameIndex(frame);
    if (index < 0 || this.rootDisposed) return Promise.resolve("unreadable");
    const helper = this.relays.get(origin) ?? this.inspectors.get(origin) ?? this.mountRelay(this.inspectors, origin, RELAY_INSPECT_QUERY);
    return new Promise((resolve) => {
      const id = this.nextInspection++;
      this.inspections.set(id, document => resolve(frameIndex(frame) === index ? document : "unreadable"));
      const ask = () => helper.frame.contentWindow?.postMessage({ type: RELAY_MESSAGE, event: "inspect", id, index } satisfies RelayMessage, origin);
      if (helper.ready) ask();
      else helper.waiting.push(ask);
    });
  }

  /**
   * Tells when the preview document in `frame` settled: by the page's own report, by the service
   * worker's error report, or, for a document that cannot report, by the frame's `load` event once
   * the relay page of the frame's origin finds a loaded document of the server in that very frame
   * (frame-watch.ts). The initial blank document, the cold-load page and error pages settle
   * nothing. The frame must be a frame of this page; it may get its address before or after the
   * watch begins.
   */
  watchFrame(frame: HTMLIFrameElement, watch: FrameWatch): () => void {
    let watching = true;
    const stopReports = this.observeFrame(frame, (message) => {
      if (message.event === "load") watch.loaded(message.href);
      if (message.event === "error") watch.failed(message.transient === true);
    });
    const domLoad = (event: Event) => {
      const origin = event.isTrusted ? this.previewOriginOf(frame) : null;
      if (origin === null) return;
      void this.inspect(frame, origin).then((document) => {
        // The frame may have been sent elsewhere while the question travelled; its next `load` asks again.
        if (watching && document === "server" && this.previewOriginOf(frame) === origin) watch.loaded(null);
      });
    };
    frame.addEventListener("load", domLoad);
    return () => {
      watching = false;
      stopReports();
      frame.removeEventListener("load", domLoad);
    };
  }

  /**
   * Closes a port's current channel without touching its listener. The service worker then asks
   * for a new one at its next request, exactly as after a restart; tests use it where a browser
   * offers no way to stop a worker.
   */
  dropAttachment(port: number): void {
    const entry = this.listening.get(port);
    entry?.session?.close();
    if (entry) entry.session = undefined;
  }

  private live(entry: Listening): boolean {
    return !this.rootDisposed && this.listening.get(entry.port) === entry && !entry.lifetime.signal.aborted;
  }

  private resolveOriginId(): Promise<string> {
    const identity = typeof this.identity === "string" ? Promise.resolve(this.identity) : Promise.resolve().then(this.identity);
    const pending = identity.then(value => previewOriginId(this.ideOrigin, value));
    this.originId = pending;
    // A failed read of the identity may succeed for the next listener.
    pending.catch(() => { if (this.originId === pending) this.originId = undefined; });
    return pending;
  }

  private loadJar(origin: string): CookieJar {
    const url = new URL(origin);
    const stored = this.cookieStore ? readStored(this.cookieStore, COOKIE_KEY + origin)?.cookies : undefined;
    return new CookieJar(url.hostname, url.protocol === "https:" || loopbackHost(url.hostname), Array.isArray(stored) ? stored : []);
  }

  private saveJar(entry: Listening): void {
    if (!this.cookieStore || !entry.jar || !entry.origin) return;
    try {
      this.cookieStore.setItem(COOKIE_KEY + entry.origin, JSON.stringify({ saved: Date.now(), cookies: entry.jar.serialize() }));
    } catch { /* A full or blocked store keeps the cookies for this tab only. */ }
  }

  /**
   * The origin's relay frame, mounted once. A dev server that restarts gets a new port on the same
   * frame, so the service worker registration is never torn down halfway.
   */
  private relayFrame(origin: string): RelayFrame {
    return this.relays.get(origin) ?? this.mountRelay(this.relays, origin, "");
  }

  /** Mounts the hidden relay page of `origin`; `query` selects its looking-only mode. */
  private mountRelay(into: Map<string, RelayFrame>, origin: string, query: string): RelayFrame {
    const frame = document.createElement("iframe");
    frame.title = "Preview relay";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.display = "none";
    frame.src = `${origin}${RELAY_PATH}${query}`;
    (document.body ?? document.documentElement).appendChild(frame);
    const relay: RelayFrame = { frame, ready: false, waiting: [] };
    into.set(origin, relay);
    return relay;
  }

  private async start(entry: Listening): Promise<void> {
    const id = await (this.originId ?? this.resolveOriginId());
    if (!this.live(entry)) return;
    const origin = previewOrigin(this.config, id, entry.port);
    this.origins.set(entry.port, origin);
    const relay = await this.bindHost({ port: entry.port, signal: entry.lifetime.signal });
    if (!this.live(entry)) { relay.close(); return; }
    entry.origin = origin;
    entry.relay = relay;
    entry.jar = this.loadJar(origin);
    entry.timer = setTimeout(() => this.fail(entry), this.relayTimeoutMs);
    if (this.relayFrame(origin).ready) this.attach(entry);
  }

  /** A fresh port for the relay frame: at first, and again whenever its service worker restarted. */
  private attach(entry: Listening): void {
    const target = entry.origin ? this.relays.get(entry.origin)?.frame.contentWindow : null;
    if (!this.live(entry) || !target || !entry.relay || !entry.jar || !entry.origin) return;
    entry.session?.close();
    const channel = new MessageChannel();
    entry.session = new PortSession(channel.port1, {
      relay: entry.relay,
      jar: entry.jar,
      sockets: entry.sockets,
      cookiesChanged: () => this.saveJar(entry),
      attached: () => this.attached(entry),
      wrapper: this.linkFor(`${entry.origin}/`),
    });
    target.postMessage({ type: RELAY_MESSAGE, event: "attach" }, entry.origin, [channel.port2]);
  }

  private attached(entry: Listening): void {
    clearTimeout(entry.timer);
    if (!this.live(entry) || entry.state !== "starting") return;
    entry.state = "ready";
    entry.ready.resolve("ready");
  }

  private fail(entry: Listening): void {
    clearTimeout(entry.timer);
    if (entry.state === "starting") entry.state = "failed";
    entry.ready.resolve("failed");
  }

  /** Revokes the port and the grant of a listener generation together, with everything in flight on them. */
  private retire(entry: Listening): void {
    this.fail(entry);
    entry.state = "failed";
    entry.session?.close();
    entry.session = undefined;
    for (const socket of Array.from(entry.sockets)) socket.close();
    entry.lifetime.abort();
  }

  private registerRoot(port: number, server: PreviewServer): symbol {
    if (this.rootDisposed) return Symbol("retired-root-preview");
    const previous = this.listening.get(port);
    if (previous?.server === server) return previous.token;
    if (previous) this.unregister(port, previous.server);
    const entry: Listening = {
      port,
      server,
      token: Symbol("root-preview"),
      lifetime: new AbortController(),
      ready: Promise.withResolvers<PreviewState>(),
      sockets: new Set(),
      state: "starting",
    };
    this.registerRouter(port, server);
    this.listening.set(port, entry);
    void this.start(entry).catch(error => {
      // A listener replaced while it was starting is not a failure worth a warning.
      if (this.live(entry)) console.warn("preview origin failed to start:", error);
      this.fail(entry);
    });
    return entry.token;
  }

  override register(port: number, server: PreviewServer): void {
    void this.registerRoot(port, server);
  }

  override registerListener(port: number, server: PreviewServer): symbol {
    return this.registerRoot(port, server);
  }

  override unregister(port: number, server: PreviewServer): void {
    const entry = this.listening.get(port);
    if (!entry || entry.server !== server) return;
    this.listening.delete(port);
    this.retire(entry);
    try { this.unregisterRouter(port, server); } catch {}
    this.origins.delete(port);
  }

  override unregisterListener(port: number, token: symbol): void {
    const entry = this.listening.get(port);
    if (entry?.token === token) this.unregister(port, entry.server);
  }

  override serves(port: number): boolean {
    return !this.rootDisposed && super.serves(port) && this.listening.get(port)?.state === "ready";
  }

  override hasListener(port: number, token: symbol): boolean {
    return !this.rootDisposed && this.listening.get(port)?.token === token;
  }

  override isListenerReady(port: number, token: symbol): boolean {
    const entry = this.listening.get(port);
    return !this.rootDisposed && entry?.token === token && entry.state === "ready";
  }

  override get ready(): Promise<PreviewState> {
    if (this.rootDisposed) return Promise.resolve("failed");
    return Promise.all(Array.from(this.listening.values(), entry => entry.ready.promise))
      .then(states => (states.every(state => state === "ready") ? "ready" : "failed"));
  }

  override async waitUntilRegistered(port: number, token: symbol): Promise<PreviewState> {
    const entry = this.listening.get(port);
    if (this.rootDisposed || entry?.token !== token) return "failed";
    const state = await entry.ready.promise;
    return this.listening.get(port) === entry && !this.rootDisposed ? state : "failed";
  }

  override dispose(): Promise<void> {
    if (this.rootDisposed) return Promise.resolve();
    this.rootDisposed = true;
    window.removeEventListener("message", this.onWindowMessage);
    this.inspections.clear();
    for (const [port, entry] of Array.from(this.listening)) {
      this.retire(entry);
      try { this.unregisterRouter(port, entry.server); } catch {}
    }
    this.listening.clear();
    this.origins.clear();
    for (const relay of Array.from(this.relays.values()).concat(Array.from(this.inspectors.values()))) relay.frame.remove();
    this.relays.clear();
    this.inspectors.clear();
    return super.dispose();
  }
}
