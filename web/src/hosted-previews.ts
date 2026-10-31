import type { Runtime } from "waffle";
import type { PreviewServer } from "waffle/browser/preview";
import { Previews, type PreviewState } from "./preview";
import { PreviewOwnerClient } from "./preview-owner-client";

interface Listening { server: PreviewServer; ready: Promise<PreviewState>; active: boolean }

/** Local serving adapter. Grants and the owner channel remain private to this page. */
export class HostedPreviews extends Previews {
  private readonly listening = new Map<number, Listening>();
  private readonly lifetime = new AbortController();
  private readonly client: Promise<PreviewOwnerClient>;
  private readonly pagehide = () => { void this.close(); };
  private release: (() => void) | undefined;
  private closing: Promise<void> | undefined;

  constructor(runtime: () => Runtime, baseURL = location.href) {
    const origins = new Map<number, string>();
    super({ mode: "root", originForPort(port) {
      const origin = origins.get(port);
      if (!origin) throw new Error("No allocated preview origin");
      return origin;
    } });
    // Resolve the page runtime before network admission, without moving shared startup code.
    this.client = Promise.resolve().then(() => {
      const owner = runtime();
      const identity = owner.filesystem.createIdentity();
      const release = owner.retainConsumer({ filesystem: identity, revoke: this.pagehide, stop: () => this.close() });
      // Runtime disposal reaps retained identities before invoking physical cleanup.
      this.release = () => { if (!owner.disposed) owner.filesystem.reap(identity); release(); };
      return PreviewOwnerClient.connect({ baseURL, signal: this.lifetime.signal, bind: async ({ origin, port, signal }) => {
        origins.set(port, origin);
        const relay = await this.bindHost({ port, signal });
        return { authorization: relay.authorization, dispatcher: relay, close: () => relay.close() };
      } });
    });
    void this.client.catch(() => this.close());
    window.addEventListener("pagehide", this.pagehide, { once: true });
  }

  override get ready(): Promise<PreviewState> {
    return this.client.then(async () => {
      const states = await Promise.all(Array.from(this.listening.values(), value => value.ready));
      return states.every(state => state === "ready") ? "ready" : "failed";
    }).catch(() => "failed");
  }
  override serves(port: number): boolean { return super.serves(port) && this.listening.get(port)?.active === true; }
  override register(port: number, server: PreviewServer): void {
    const previous = this.listening.get(port);
    if (previous?.server === server) return;
    if (previous) this.unregister(port, previous.server);
    super.register(port, server);
    const value: Listening = { server, active: false, ready: Promise.resolve("failed") };
    this.listening.set(port, value);
    value.ready = this.client.then(async client => {
      if (this.listening.get(port) !== value || this.lifetime.signal.aborted) return "failed";
      await client.register(port);
      if (this.listening.get(port) !== value || this.lifetime.signal.aborted) return "failed";
      value.active = true;
      return "ready";
    }).catch(() => "failed");
  }
  override unregister(port: number, server: PreviewServer): void {
    if (this.listening.get(port)?.server !== server) return;
    this.listening.delete(port);
    super.unregister(port, server);
    void this.client.then(client => client.unregister(port)).catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    window.removeEventListener("pagehide", this.pagehide);
    for (const [port, value] of this.listening) super.unregister(port, value.server);
    this.listening.clear();
    this.closing = this.client.then(client => client.shutdown(), () => {}).then(() => { this.release?.(); });
    return this.closing;
  }
}
