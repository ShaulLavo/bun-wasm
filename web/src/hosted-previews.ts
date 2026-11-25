import type { Runtime } from "waffle";
import type { PreviewServer } from "waffle/browser/preview";
import type { PreviewHostDispatcher, PreviewHostRelay } from "waffle/browser/preview-host";
import { Previews, type PreviewState } from "./preview";
import { PreviewCleanupError, PreviewOwnerClient } from "./preview-owner-client";

interface Listening {
  readonly server: PreviewServer;
  readonly guardedServer: PreviewServer;
  readonly token: symbol;
  ready: ReturnType<typeof Promise.withResolvers<PreviewState>>;
  active: boolean;
  origin?: string;
}

export interface HostedPreviewsOptions {
  managePageHide?: boolean;
}

/** Local serving adapter. Grants and the owner channel remain private to this page. */
export class HostedPreviews extends Previews {
  private readonly listening = new Map<number, Listening>();
  private readonly relayOps = new Map<number, Promise<void>>();
  private readonly lifetime = new AbortController();
  private readonly client: Promise<PreviewOwnerClient>;
  private readonly managePageHide: boolean;
  private readonly deferredLateRelays = new Set<PreviewHostRelay>();
  private readonly physicalCleanupErrors: unknown[] = [];

  private runtimeOwner: Runtime | undefined;
  private release: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private hostedDisposed = false;
  private relayFailed = false;
  private physicalStopStarted = false;

  private readonly onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    void this.dispose().catch(() => {});
  };

  constructor(runtime: () => Runtime, baseURL = location.href, options: HostedPreviewsOptions = {}) {
    const origins = new Map<number, string>();
    super({
      mode: "root",
      originForPort(port) {
        const origin = origins.get(port);
        if (!origin) throw new Error("No allocated preview origin");
        return origin;
      },
    });
    this.managePageHide = options.managePageHide ?? true;

    this.client = Promise.resolve().then(() => {
      if (this.hostedDisposed || this.lifetime.signal.aborted) {
        throw new Error("Hosted previews revoked");
      }
      const owner = runtime();
      this.runtimeOwner = owner;
      const identity = owner.filesystem.createIdentity();
      const release = owner.retainConsumer({
        filesystem: identity,
        revoke: () => this.revoke(),
        stop: () => this.closePhysical(),
      });
      this.release = () => {
        if (!owner.disposed) owner.filesystem.reap(identity);
        release();
      };
      return PreviewOwnerClient.connect({
        baseURL,
        signal: this.lifetime.signal,
        onClose: () => this.failRelayConnection(),
        shouldDeferBindingCleanup: () => this.isFenceDeferring(),
        bind: async ({ origin, port, signal }) => {
          if (this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted || signal.aborted) {
            return null;
          }
          origins.set(port, origin);
          const settleUnusedRelay = (relay: PreviewHostRelay) => {
            if (this.isFenceDeferring()) {
              this.deferredLateRelays.add(relay);
            } else {
              try {
                relay.close();
              } catch (err) {
                this.physicalCleanupErrors.push(err);
              }
            }
          };
          const relay = await new Promise<PreviewHostRelay | null>((resolve, reject) => {
            let done = false;
            const onAbort = () => {
              if (done) return;
              done = true;
              resolve(null);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            this.bindHost({ port, signal }).then(
              (bound) => {
                signal.removeEventListener("abort", onAbort);
                if (done || signal.aborted || this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) {
                  settleUnusedRelay(bound);
                  if (!done) {
                    done = true;
                    resolve(null);
                  }
                  return;
                }
                done = true;
                resolve(bound);
              },
              (err) => {
                signal.removeEventListener("abort", onAbort);
                if (done) return;
                done = true;
                if (signal.aborted || this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) {
                  resolve(null);
                } else {
                  reject(err);
                }
              },
            );
          });
          if (!relay) return null;
          if (signal.aborted || this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) {
            settleUnusedRelay(relay);
            return null;
          }
          const dispatcher: PreviewHostDispatcher = {
            dispatch: async (open, exchange) => {
              if (this.hostedDisposed || this.relayFailed) {
                exchange.postMessage({ type: "error", message: "Preview server revoked" });
                exchange.close();
                return;
              }
              await relay.dispatch(open, exchange);
            },
          };
          return {
            authorization: relay.authorization,
            dispatcher,
            close: () => relay.close(),
          };
        },
      });
    });

    void this.client.catch((err) => {
      if (err instanceof PreviewCleanupError) this.physicalCleanupErrors.push(err);
      this.failRelayConnection();
    });
    if (this.managePageHide && typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
    }
  }

  hasActiveConsumer(): boolean {
    return this.release !== undefined;
  }

  private isFenceDeferring(): boolean {
    return this.hasActiveConsumer() && !this.physicalStopStarted && (this.hostedDisposed || Boolean(this.runtimeOwner?.disposed));
  }

  private retireEntry(entry: Listening): void {
    entry.active = false;
    entry.ready.resolve("failed");
  }

  private failRelayConnection(): void {
    this.relayFailed = true;
    if (this.managePageHide && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    for (const entry of this.listening.values()) {
      this.retireEntry(entry);
    }
    if (this.isFenceDeferring()) return;
    this.lifetime.abort();
    void this.client
      .then(
        (client) => (this.isFenceDeferring() ? undefined : client.shutdown()),
        (err) => {
          if (err instanceof PreviewCleanupError) throw err;
        },
      )
      .then(
        () => {
          if (this.physicalCleanupErrors.length === 0 && !this.isFenceDeferring()) {
            const rel = this.release;
            this.release = undefined;
            rel?.();
          }
        },
        (err) => {
          this.physicalCleanupErrors.push(err);
        },
      );
  }

  private enqueueRelayOp(port: number, fn: () => Promise<void>): void {
    const prev = this.relayOps.get(port) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await fn();
      } catch {
        // Relay command failures are handled per-entry inside fn.
      }
    });
    this.relayOps.set(port, next);
    void next.finally(() => {
      if (this.relayOps.get(port) === next) this.relayOps.delete(port);
    });
  }

  private registerHosted(port: number, server: PreviewServer, token: symbol): symbol {
    if (this.hostedDisposed) return Symbol("retired-hosted-preview");
    const previous = this.listening.get(port);
    if (previous?.server === server) return previous.token;
    if (previous) this.unregister(port, previous.server);

    const entry: Listening = {
      server,
      guardedServer: {
        connect: (p, sink) => {
          if (this.hostedDisposed || this.relayFailed || this.listening.get(port) !== entry) return null;
          return server.connect(p, sink);
        },
        request: (p, req, sink) => {
          if (this.hostedDisposed || this.relayFailed || this.listening.get(port) !== entry) return false;
          return server.request(p, req, sink);
        },
      },
      token,
      active: false,
      ready: Promise.withResolvers<PreviewState>(),
    };
    this.registerRouter(port, entry.guardedServer);
    this.listening.set(port, entry);
    if (this.relayFailed) {
      this.retireEntry(entry);
      return token;
    }
    this.enqueueRelayOp(port, async () => {
      try {
        const client = await this.client;
        if (this.listening.get(port) !== entry || this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) {
          this.retireEntry(entry);
          return;
        }
        const readyPromise = client.register(port);
        void readyPromise.then(
          (origin) => {
            if (this.listening.get(port) !== entry || this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) {
              this.retireEntry(entry);
              return;
            }
            entry.origin = origin;
            entry.active = true;
            entry.ready.resolve("ready");
          },
          () => this.retireEntry(entry),
        );
      } catch {
        this.retireEntry(entry);
      }
    });
    return token;
  }

  override register(port: number, server: PreviewServer): void {
    void this.registerHosted(port, server, Symbol("hosted-preview"));
  }

  override registerListener(port: number, server: PreviewServer): symbol {
    return this.registerHosted(port, server, Symbol("hosted-preview"));
  }

  override unregister(port: number, server: PreviewServer): void {
    const entry = this.listening.get(port);
    if (!entry || entry.server !== server) return;
    this.retireEntry(entry);
    if (this.isFenceDeferring()) return;
    this.listening.delete(port);
    try {
      this.unregisterRouter(port, entry.guardedServer);
    } catch (err) {
      this.physicalCleanupErrors.push(err);
    }
    this.enqueueRelayOp(port, async () => {
      if (this.isFenceDeferring()) return;
      const client = await this.client;
      if (this.isFenceDeferring()) return;
      client.unregister(port);
    });
  }

  override unregisterListener(port: number, token: symbol): void {
    const entry = this.listening.get(port);
    if (!entry || entry.token !== token) return;
    this.unregister(port, entry.server);
  }

  override serves(port: number): boolean {
    return (
      !this.hostedDisposed &&
      !this.relayFailed &&
      !this.lifetime.signal.aborted &&
      super.serves(port) &&
      this.listening.get(port)?.active === true
    );
  }

  override hasListener(port: number, token: symbol): boolean {
    return !this.hostedDisposed && this.listening.get(port)?.token === token;
  }

  override isListenerReady(port: number, token: symbol): boolean {
    const entry = this.listening.get(port);
    return (
      !this.hostedDisposed &&
      !this.relayFailed &&
      !this.lifetime.signal.aborted &&
      entry?.token === token &&
      entry.active === true
    );
  }

  override get ready(): Promise<PreviewState> {
    if (this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) {
      return Promise.resolve("failed");
    }
    return this.client
      .then(async () => {
        if (this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) return "failed" as const;
        const entries = Array.from(this.listening.entries());
        const states = await Promise.all(entries.map(([port, entry]) => this.waitUntilRegistered(port, entry.token)));
        if (this.hostedDisposed || this.relayFailed || this.lifetime.signal.aborted) return "failed" as const;
        return states.every((state) => state === "ready") ? ("ready" as const) : ("failed" as const);
      })
      .catch(() => "failed" as const);
  }

  override async waitUntilRegistered(port: number, token: symbol): Promise<PreviewState> {
    const entry = this.listening.get(port);
    if (this.hostedDisposed || !entry || entry.token !== token || this.relayFailed || this.lifetime.signal.aborted) {
      return "failed";
    }
    const state = await entry.ready.promise;
    const current = this.listening.get(port);
    if (
      this.hostedDisposed ||
      !current ||
      current.token !== token ||
      !current.active ||
      this.relayFailed ||
      this.lifetime.signal.aborted
    ) {
      return "failed";
    }
    return state;
  }

  revoke(): void {
    this.hostedDisposed = true;
    this.relayFailed = true;
    for (const entry of this.listening.values()) {
      this.retireEntry(entry);
    }
  }

  private closePhysical(): Promise<void> {
    if (this.closing) return this.closing;
    this.physicalStopStarted = true;
    this.revoke();
    this.lifetime.abort();
    if (this.managePageHide && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    for (const relay of Array.from(this.deferredLateRelays)) {
      this.deferredLateRelays.delete(relay);
      try {
        relay.close();
      } catch (err) {
        this.physicalCleanupErrors.push(err);
      }
    }
    for (const [port, entry] of Array.from(this.listening)) {
      try {
        this.unregisterRouter(port, entry.guardedServer);
      } catch (err) {
        this.physicalCleanupErrors.push(err);
      }
    }
    this.listening.clear();
    this.closing = this.client
      .then(
        (client) => client.shutdown(),
        (err) => {
          if (err instanceof PreviewCleanupError) this.physicalCleanupErrors.push(err);
        },
      )
      .catch((err) => {
        this.physicalCleanupErrors.push(err);
      })
      .then(() => {
        if (this.physicalCleanupErrors.length > 0) {
          throw new AggregateError([...this.physicalCleanupErrors], "HostedPreviews physical cleanup failed");
        }
        const rel = this.release;
        this.release = undefined;
        rel?.();
      });
    return this.closing;
  }

  override dispose(): Promise<void> {
    this.revoke();
    if (this.hasActiveConsumer() && this.runtimeOwner !== undefined) {
      return this.runtimeOwner.dispose();
    }
    const closing = this.closePhysical();
    void super.dispose();
    return closing;
  }

  close(): Promise<void> {
    return this.dispose();
  }
}
