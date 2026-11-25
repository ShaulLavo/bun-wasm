// Bun's registration policy; routing and socket transport are guest-independent.
import { ResponseParser, serializeRequest } from "waffle/browser/net/http1";
import type { PreviewConnection } from "waffle/browser/net/helper";
import { PreviewRouter, type PreviewOptions, type PreviewServer } from "waffle/browser/preview";
import type { PreviewMessage, PreviewReply } from "waffle/browser/preview-protocol";
import { swScriptUrl } from "./entry-assets.js";
import { PREVIEW_DIR } from "./preview-protocol";

export { activated } from "waffle/browser/service-worker";
export type PreviewState = "ready" | "unsupported" | "failed";

const UNROUTED_PREVIEW_KEY = "__unrouted__";
const PREVIEW_ROUTE_PATTERN = /^(?:ws|mem|pg)-[a-zA-Z0-9._-]+$/;

function isValidPreviewRoute(route: string): boolean {
  return PREVIEW_ROUTE_PATTERN.test(route);
}

function previewRouteKey(route: string | undefined): string {
  return route ?? UNROUTED_PREVIEW_KEY;
}

export type PreviewsOptions = PreviewOptions & { route?: string };

interface PortRegistration {
  readonly token: symbol;
  readonly server: PreviewServer;
  generation: number;
  worker: ServiceWorker | null;
  ackId: symbol | null;
  ackState: "pending" | "acked" | "failed";
  readonly ackWaiters: Set<() => void>;
  cancelAck: (() => void) | null;
  isRetired: boolean;
  readonly retireController: AbortController | null;
}

const ACK_TIMEOUT_MS = 5_000;

function drainWaiters(waiters: Set<() => void>): void {
  const callbacks = Array.from(waiters);
  waiters.clear();
  for (const cb of callbacks) cb();
}

function waitUntilSets(sets: readonly Set<() => void>[], signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      for (const s of sets) s.delete(onWake);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onWake = () => finish(true);
    const onAbort = () => finish(false);
    for (const s of sets) s.add(onWake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitUntilEvent(waiters: Set<() => void>, signal?: AbortSignal): Promise<boolean> {
  return waitUntilSets([waiters], signal);
}

function waitUntilEither(setA: Set<() => void>, setB: Set<() => void>, signal?: AbortSignal): Promise<boolean> {
  return waitUntilSets([setA, setB], signal);
}

function postAndAck(
  worker: ServiceWorker,
  message: Record<string, unknown>,
  timeoutMs = ACK_TIMEOUT_MS,
): { promise: Promise<boolean>; cancel: () => void } {
  if (typeof worker.postMessage !== "function" || typeof MessageChannel === "undefined") {
    return { promise: Promise.resolve(true), cancel: () => {} };
  }
  const channel = new MessageChannel();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (ok: boolean) => void;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    channel.port1.onmessage = null;
    try { channel.port1.close(); } catch {}
    try { channel.port2.close(); } catch {}
    resolvePromise(ok);
  };
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === "object" && "type" in event.data && event.data.type === "preview-register-ack") {
        finish(true);
      }
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      finish(false);
    }
  });
  return { promise, cancel: () => finish(false) };
}

function activatedWorker(registration: ServiceWorkerRegistration): ServiceWorker | null {
  if (registration.active?.state === "activated") return registration.active;
  if (registration.waiting?.state === "activated") return registration.waiting;
  if (registration.installing?.state === "activated") return registration.installing;
  return null;
}

function isObservablePending(registration: ServiceWorkerRegistration, worker: ServiceWorker | null): worker is ServiceWorker {
  return (
    worker !== null &&
    worker.state !== "activated" &&
    worker.state !== "redundant" &&
    (worker === registration.installing ||
      worker === registration.waiting ||
      (worker === registration.active && worker.state === "activating"))
  );
}

type ExtendedPreviewMessage =
  | (PreviewMessage & { route?: string })
  | { type: "preview-sync"; route?: string };

export class Previews extends PreviewRouter {
  protected readonly workerScope: URL | undefined;
  protected readonly mountBaseURL: string | undefined;
  protected readonly route: string | undefined;
  protected readonly routeKey: string;
  protected readonly routePrefix: string | undefined;

  private readonly localServers = new Map<number, PreviewServer>();
  private readonly portRegistrations = new Map<number, PortRegistration>();
  private readonly recoveryListeners = new Set<() => void>();

  private readonly bootstrapWaiters = new Set<() => void>();
  private readonly stateWaiters = new Set<() => void>();
  private readonly updateObservers = new Map<ServiceWorker, () => void>();

  private disposed = false;
  private bootstrapStarted = false;
  private bootstrapState: PreviewState | null = null;
  private swRegistration: ServiceWorkerRegistration | null = null;
  private expectedScriptUrl: string | null = null;
  private activeWorker: ServiceWorker | null = null;
  private workerGeneration = 0;
  private currentReadyState: PreviewState = "failed";
  private workerReadySettled = false;
  private activeBatchAckCancel: (() => void) | null = null;
  private generationReadyCache: { generation: number; promise: Promise<PreviewState> } | null = null;
  private awaitedCandidate: { worker: ServiceWorker; cleanup: () => void } | null = null;
  private failedCandidate: ServiceWorker | null = null;

  private readonly onContainerMessage = (event: MessageEvent) => {
    this.onMessage(event as unknown as Parameters<PreviewRouter["onMessage"]>[0]);
  };
  private readonly onUpdateFound = () => {
    this.reconcileActiveWorker();
  };

  constructor(options: PreviewsOptions = { baseURL: location.href, prefix: PREVIEW_DIR }) {
    super(options);
    if (options.route !== undefined && !isValidPreviewRoute(options.route)) {
      throw new TypeError(`Invalid preview route: ${options.route}`);
    }
    this.route = options.route;
    this.routeKey = previewRouteKey(options.route);
    if ("prefix" in options) {
      this.workerScope = new URL(`${options.prefix}/`, options.baseURL);
      this.mountBaseURL = options.baseURL;
      this.routePrefix = this.route
        ? `${this.workerScope.pathname}r/${this.route}/`
        : this.workerScope.pathname;
    } else {
      this.workerScope = undefined;
      this.mountBaseURL = undefined;
      this.routePrefix = undefined;
    }
  }

  protected registerRouter(port: number, server: PreviewServer): void {
    super.register(port, server);
  }

  protected unregisterRouter(port: number, server: PreviewServer): void {
    super.unregister(port, server);
  }

  override url(port: number, path = "/"): string {
    if (!this.workerScope || !this.mountBaseURL || !this.route || !this.routePrefix) {
      return super.url(port, path);
    }
    return new URL(`${this.routePrefix}${port}${path}`, this.mountBaseURL).href;
  }

  /** The link that opens a preview URL in a new tab. Mounted previews are their own link; preview origins use a wrapper page. */
  linkFor(url: string): string {
    return url;
  }

  linkUrl(port: number, path = "/"): string {
    return this.linkFor(this.url(port, path));
  }

  get ready(): Promise<PreviewState> {
    if (this.disposed) return Promise.resolve("failed");
    if (this.workerScope === undefined) return Promise.resolve("ready");
    this.maybeRetryFailedActiveWorkerBatch();
    this.startRegistrationBootstrap();
    if (this.generationReadyCache?.generation === this.workerGeneration) {
      return this.generationReadyCache.promise;
    }
    const gen = this.workerGeneration;
    const promise = this.waitForActiveWorkerReady().then((result) => result.state);
    this.generationReadyCache = { generation: gen, promise };
    return promise;
  }

  onWorkerRecovered(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.recoveryListeners.add(listener);
    return () => { this.recoveryListeners.delete(listener); };
  }

  private notifyRecovered(): void {
    for (const listener of Array.from(this.recoveryListeners)) {
      try { listener(); } catch {}
    }
  }

  private invalidateGeneration(nextState: PreviewState, settled: boolean): void {
    this.activeBatchAckCancel?.();
    this.activeBatchAckCancel = null;
    for (const entry of this.portRegistrations.values()) {
      entry.cancelAck?.();
      entry.cancelAck = null;
      drainWaiters(entry.ackWaiters);
    }
    this.workerGeneration++;
    this.generationReadyCache = null;
    this.currentReadyState = nextState;
    this.workerReadySettled = settled;
    drainWaiters(this.stateWaiters);
  }

  private retireRegistration(entry: PortRegistration): void {
    entry.isRetired = true;
    entry.cancelAck?.();
    entry.cancelAck = null;
    entry.ackId = null;
    entry.retireController?.abort();
    drainWaiters(entry.ackWaiters);
  }

  private startRegistrationBootstrap(): void {
    if (this.bootstrapStarted) return;
    this.bootstrapStarted = true;
    if (this.disposed) {
      this.bootstrapState = "failed";
      drainWaiters(this.bootstrapWaiters);
      return;
    }
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) {
      this.bootstrapState = "unsupported";
      this.currentReadyState = "unsupported";
      this.workerReadySettled = true;
      drainWaiters(this.bootstrapWaiters);
      drainWaiters(this.stateWaiters);
      return;
    }
    container.addEventListener?.("message", this.onContainerMessage);
    container.startMessages?.();
    const scriptUrl = swScriptUrl();
    try {
      this.expectedScriptUrl = new URL(scriptUrl, typeof location !== "undefined" ? location.href : this.mountBaseURL).href;
    } catch {
      this.expectedScriptUrl = scriptUrl;
    }
    void container
      .register(scriptUrl, { scope: this.workerScope?.href, updateViaCache: "none" })
      .then(
        (registration) => {
          if (this.disposed) return;
          this.swRegistration = registration;
          registration.addEventListener?.("updatefound", this.onUpdateFound);
          this.reconcileActiveWorker();
          this.bootstrapState = "ready";
          drainWaiters(this.bootstrapWaiters);
        },
        (err) => {
          console.warn("preview service worker registration failed:", err);
          if (this.disposed) return;
          this.bootstrapState = "failed";
          this.currentReadyState = "failed";
          this.workerReadySettled = true;
          drainWaiters(this.bootstrapWaiters);
          drainWaiters(this.stateWaiters);
        },
      );
  }

  private async waitForActiveWorkerReady(
    retireSignal?: AbortSignal,
  ): Promise<{ readonly state: PreviewState; readonly generation: number }> {
    if (this.disposed || retireSignal?.aborted) {
      return { state: "failed", generation: this.workerGeneration };
    }
    this.startRegistrationBootstrap();
    while (this.bootstrapState === null) {
      if (!(await waitUntilEvent(this.bootstrapWaiters, retireSignal)) || this.disposed) {
        return { state: "failed", generation: this.workerGeneration };
      }
    }
    if (this.bootstrapState !== "ready") {
      return { state: this.bootstrapState, generation: this.workerGeneration };
    }
    while (true) {
      if (this.disposed || retireSignal?.aborted) {
        return { state: "failed", generation: this.workerGeneration };
      }
      this.reconcileActiveWorker();
      const seenGen = this.workerGeneration;
      if (!this.workerReadySettled) {
        if (!(await waitUntilEvent(this.stateWaiters, retireSignal)) || this.disposed) {
          return { state: "failed", generation: this.workerGeneration };
        }
        this.reconcileActiveWorker();
        if (this.workerGeneration !== seenGen || !this.workerReadySettled) continue;
      }
      return { state: this.currentReadyState, generation: seenGen };
    }
  }

  private observePendingUpdates(registration: ServiceWorkerRegistration): void {
    for (const [worker, cleanup] of Array.from(this.updateObservers)) {
      if (!isObservablePending(registration, worker)) {
        cleanup();
        this.updateObservers.delete(worker);
      }
    }
    for (const worker of [registration.installing, registration.waiting, registration.active]) {
      if (!isObservablePending(registration, worker) || this.updateObservers.has(worker)) continue;
      const onStateChange = () => {
        if (worker.state === "activated" || worker.state === "redundant") {
          cleanup();
          this.updateObservers.delete(worker);
          if (worker.state === "activated") this.reconcileActiveWorker();
        }
      };
      const cleanup = () => {
        worker.removeEventListener("statechange", onStateChange);
      };
      worker.addEventListener("statechange", onStateChange);
      this.updateObservers.set(worker, cleanup);
    }
  }

  private syncActiveWorker(registration: ServiceWorkerRegistration): void {
    const live = activatedWorker(registration);
    if (!live || this.disposed) return;
    this.activeWorker = live;
    this.publishGenerationSnapshot(live);
  }

  private publishGenerationSnapshot(worker: ServiceWorker): void {
    this.invalidateGeneration("failed", false);
    const gen = this.workerGeneration;
    const batchAckId = Symbol("preview-batch-ack");
    const included: Array<[number, symbol]> = Array.from(
      this.portRegistrations,
      ([port, entry]) => [port, entry.token],
    );
    for (const [port] of included) {
      const entry = this.portRegistrations.get(port);
      if (!entry || entry.isRetired) continue;
      entry.generation = gen;
      entry.worker = worker;
      entry.ackId = batchAckId;
      entry.ackState = "pending";
      entry.cancelAck = null;
    }
    const batch = postAndAck(worker, {
      type: "preview-register-all",
      route: this.routeKey,
      ports: included.map(([p]) => p),
    });
    this.activeBatchAckCancel = batch.cancel;
    void batch.promise.then((ok) => {
      if (this.disposed || gen !== this.workerGeneration) return;
      this.activeBatchAckCancel = null;
      this.currentReadyState = ok ? "ready" : "failed";
      this.workerReadySettled = true;
      for (const [port, token] of included) {
        const entry = this.portRegistrations.get(port);
        if (entry && !entry.isRetired && entry.token === token && entry.ackId === batchAckId && entry.worker === worker) {
          entry.ackState = ok ? "acked" : "failed";
          drainWaiters(entry.ackWaiters);
        }
      }
      drainWaiters(this.stateWaiters);
      if (ok) this.notifyRecovered();
    });
  }

  private pendingExpectedUpgrade(registration: ServiceWorkerRegistration, liveActive: ServiceWorker | null): ServiceWorker | null {
    if (!this.expectedScriptUrl || !liveActive || typeof liveActive.scriptURL !== "string") return null;
    if (liveActive.scriptURL === this.expectedScriptUrl) return null;
    return (
      [registration.waiting, registration.installing].find(
        (w): w is ServiceWorker =>
          isObservablePending(registration, w) &&
          w !== this.failedCandidate &&
          typeof w.scriptURL === "string" &&
          w.scriptURL === this.expectedScriptUrl,
      ) ?? null
    );
  }

  private awaitCandidateActivation(registration: ServiceWorkerRegistration, candidate: ServiceWorker): void {
    let cleaned = false;
    const onCheck = () => {
      if (cleaned || this.disposed) return;
      this.observePendingUpdates(registration);
      const live = activatedWorker(registration);
      if (live && !this.pendingExpectedUpgrade(registration, live)) {
        cleanup();
        this.awaitedCandidate = null;
        this.failedCandidate = null;
        this.syncActiveWorker(registration);
        return;
      }
      if (!isObservablePending(registration, candidate)) {
        cleanup();
        this.awaitedCandidate = null;
        this.failedCandidate = candidate;
        if (live) {
          this.syncActiveWorker(registration);
        } else {
          this.invalidateGeneration("failed", true);
        }
      }
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      candidate.removeEventListener("statechange", onCheck);
    };
    candidate.addEventListener("statechange", onCheck);
    this.awaitedCandidate = { worker: candidate, cleanup };
  }

  private reconcileActiveWorker(): ServiceWorker | null {
    if (this.disposed) return null;
    const registration = this.swRegistration;
    if (!registration) return null;
    this.observePendingUpdates(registration);
    const liveActive = activatedWorker(registration);
    const upgrading = this.pendingExpectedUpgrade(registration, liveActive);
    if (liveActive && !upgrading) {
      if (liveActive !== this.activeWorker) {
        this.awaitedCandidate?.cleanup();
        this.awaitedCandidate = null;
        this.failedCandidate = null;
        this.syncActiveWorker(registration);
      }
      return liveActive;
    }
    const candidate =
      upgrading ??
      [registration.active, registration.waiting, registration.installing].find(
        (w): w is ServiceWorker => isObservablePending(registration, w),
      ) ??
      null;
    if (candidate === null) {
      this.failedCandidate = null;
      if (
        this.activeWorker !== null ||
        this.awaitedCandidate !== null ||
        this.currentReadyState === "ready" ||
        !this.workerReadySettled
      ) {
        this.awaitedCandidate?.cleanup();
        this.awaitedCandidate = null;
        this.activeWorker = null;
        this.invalidateGeneration("failed", true);
      }
      return null;
    }
    if (candidate === this.failedCandidate) {
      this.currentReadyState = "failed";
      this.workerReadySettled = true;
      return null;
    }
    if (candidate !== this.awaitedCandidate?.worker) {
      this.awaitedCandidate?.cleanup();
      this.awaitedCandidate = null;
      this.failedCandidate = null;
      this.activeWorker = null;
      this.invalidateGeneration("failed", false);
      this.awaitCandidateActivation(registration, candidate);
    }
    return null;
  }

  private maybeRetryFailedActiveWorkerBatch(): ServiceWorker | null {
    if (this.disposed || !this.swRegistration) return null;
    const liveActive = this.reconcileActiveWorker();
    if (
      liveActive !== null &&
      this.activeWorker === liveActive &&
      this.workerReadySettled &&
      this.currentReadyState === "failed"
    ) {
      this.publishGenerationSnapshot(liveActive);
    }
    return liveActive;
  }

  private sendPortAck(port: number, entry: PortRegistration, worker: ServiceWorker, gen: number, isRetry = false): void {
    const portAckId = Symbol("preview-port-ack");
    entry.generation = gen;
    entry.worker = worker;
    entry.ackId = portAckId;
    entry.ackState = "pending";
    const req = postAndAck(worker, { type: "preview-register", route: this.routeKey, port });
    entry.cancelAck = req.cancel;
    void req.promise.then((ok) => {
      if (
        !this.disposed &&
        !entry.isRetired &&
        this.portRegistrations.get(port) === entry &&
        entry.ackId === portAckId &&
        gen === this.workerGeneration &&
        entry.worker === worker
      ) {
        entry.ackState = ok ? "acked" : "failed";
        entry.cancelAck = null;
        drainWaiters(entry.ackWaiters);
        if (isRetry && ok) this.notifyRecovered();
      }
    });
  }

  private maybeRetryFailedPortAck(port: number, entry: PortRegistration): ServiceWorker | null {
    if (this.disposed || entry.isRetired || this.portRegistrations.get(port) !== entry) return null;
    const liveActive = this.maybeRetryFailedActiveWorkerBatch();
    if (
      liveActive !== null &&
      this.activeWorker === liveActive &&
      this.currentReadyState === "ready" &&
      this.workerReadySettled &&
      entry.generation === this.workerGeneration &&
      entry.worker === liveActive &&
      entry.ackState === "failed" &&
      entry.cancelAck === null
    ) {
      this.sendPortAck(port, entry, liveActive, this.workerGeneration, true);
    }
    return liveActive;
  }

  private registerInternal(port: number, server: PreviewServer): symbol {
    if (this.disposed) return Symbol("retired-preview");
    const existing = this.portRegistrations.get(port);
    if (existing?.server === server) {
      this.maybeRetryFailedPortAck(port, existing);
      return existing.token;
    }
    if (existing) {
      this.portRegistrations.delete(port);
      this.retireRegistration(existing);
      try { this.unregisterRouter(port, existing.server); } catch {}
    }
    this.registerRouter(port, server);
    this.localServers.set(port, server);
    const token = Symbol("preview-listener");
    const entry: PortRegistration = {
      token,
      server,
      generation: -1,
      worker: null,
      ackId: null,
      ackState: "pending",
      ackWaiters: new Set(),
      cancelAck: null,
      isRetired: false,
      retireController: typeof AbortController === "function" ? new AbortController() : null,
    };
    this.portRegistrations.set(port, entry);
    if (this.workerScope !== undefined) {
      const liveActive = this.maybeRetryFailedActiveWorkerBatch();
      if (liveActive !== null && entry.generation === this.workerGeneration && entry.worker === liveActive && entry.ackId !== null) {
        return token;
      }
      if (liveActive !== null && this.activeWorker === liveActive) {
        this.sendPortAck(port, entry, liveActive, this.workerGeneration, false);
      }
    }
    return token;
  }

  override register(port: number, server: PreviewServer): void {
    void this.registerInternal(port, server);
  }

  registerListener(port: number, server: PreviewServer): symbol {
    return this.registerInternal(port, server);
  }

  override unregister(port: number, server: PreviewServer): void {
    if (this.localServers.get(port) !== server) return;
    this.localServers.delete(port);
    const existing = this.portRegistrations.get(port);
    if (existing) {
      this.portRegistrations.delete(port);
      this.retireRegistration(existing);
    }
    try { this.unregisterRouter(port, server); } catch {}
    try { this.activeWorker?.postMessage({ type: "preview-unregister", route: this.routeKey, port }); } catch {}
  }

  unregisterListener(port: number, token: symbol): void {
    const existing = this.portRegistrations.get(port);
    if (!existing || existing.token !== token) return;
    this.unregister(port, existing.server);
  }

  hasListener(port: number, token: symbol): boolean {
    return !this.disposed && this.portRegistrations.get(port)?.token === token;
  }

  isListenerReady(port: number, token: symbol): boolean {
    if (this.disposed) return false;
    const entry = this.portRegistrations.get(port);
    if (!entry || entry.token !== token || entry.isRetired) return false;
    if (this.workerScope === undefined) return true;
    const liveActive = this.reconcileActiveWorker();
    return (
      entry.ackState === "acked" &&
      entry.generation === this.workerGeneration &&
      this.currentReadyState === "ready" &&
      this.workerReadySettled &&
      liveActive !== null &&
      liveActive.state === "activated" &&
      entry.worker === liveActive
    );
  }

  async waitUntilRegistered(port: number, token: symbol): Promise<PreviewState> {
    const initial = this.portRegistrations.get(port);
    if (this.disposed || !initial || initial.token !== token || initial.isRetired) return "failed";
    if (this.workerScope === undefined) return "ready";
    this.maybeRetryFailedPortAck(port, initial);
    const retireSignal = initial.retireController?.signal;
    while (true) {
      const { state, generation: seenGen } = await this.waitForActiveWorkerReady(retireSignal);
      if (this.disposed || retireSignal?.aborted || initial.isRetired || this.portRegistrations.get(port) !== initial) {
        return "failed";
      }
      this.reconcileActiveWorker();
      if (this.workerGeneration !== seenGen) continue;
      if (state !== "ready") return state;
      if (initial.generation !== seenGen) continue;
      while (initial.ackState === "pending" && initial.generation === seenGen && this.workerGeneration === seenGen) {
        const woke = await waitUntilEither(initial.ackWaiters, this.stateWaiters, retireSignal);
        if (!woke || this.disposed || retireSignal?.aborted || initial.isRetired || this.portRegistrations.get(port) !== initial) {
          return "failed";
        }
      }
      const liveActive = this.reconcileActiveWorker();
      if (liveActive === null || liveActive !== initial.worker) continue;
      if (initial.generation !== seenGen || this.workerGeneration !== seenGen) continue;
      return initial.ackState === "acked" ? "ready" : "failed";
    }
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.bootstrapState = "failed";
    this.invalidateGeneration("failed", true);
    if (typeof navigator !== "undefined") {
      navigator.serviceWorker?.removeEventListener?.("message", this.onContainerMessage);
    }
    this.swRegistration?.removeEventListener?.("updatefound", this.onUpdateFound);
    for (const cleanup of this.updateObservers.values()) cleanup();
    this.updateObservers.clear();
    this.awaitedCandidate?.cleanup();
    this.awaitedCandidate = null;
    for (const [port, entry] of Array.from(this.portRegistrations)) {
      this.retireRegistration(entry);
      try { this.unregisterRouter(port, entry.server); } catch {}
      try { this.activeWorker?.postMessage({ type: "preview-unregister", route: this.routeKey, port }); } catch {}
    }
    this.portRegistrations.clear();
    this.localServers.clear();
    this.recoveryListeners.clear();
    drainWaiters(this.bootstrapWaiters);
    drainWaiters(this.stateWaiters);
    return Promise.resolve();
  }

  override onMessage(event: Pick<MessageEvent<ExtendedPreviewMessage>, "data" | "ports">): void {
    const ask = event.data;
    const reply = event.ports[0];
    if (!ask || !reply) return;
    if (ask.type === "preview-sync") {
      try {
        reply.postMessage({
          type: "preview-sync-reply",
          route: this.routeKey,
          ports: this.disposed ? [] : Array.from(this.localServers.keys()),
        });
      } finally {
        try { reply.close(); } catch {}
      }
      return;
    }
    if (this.disposed) {
      try {
        reply.postMessage({ type: ask.type === "preview-socket" ? "error" : "none" });
      } catch {}
      try { reply.close(); } catch {}
      return;
    }
    if (ask.route !== undefined && ask.route !== this.routeKey) {
      try {
        reply.postMessage({ type: ask.type === "preview-socket" ? "error" : "none" });
      } catch {}
      try { reply.close(); } catch {}
      return;
    }
    if (ask.type !== "preview-request") {
      super.onMessage(event as Parameters<PreviewRouter["onMessage"]>[0]);
      return;
    }

    const server = this.localServers.get(ask.port);
    if (!server) {
      reply.postMessage({ type: "none" });
      reply.close();
      return;
    }

    const headers = ask.headers.filter(([name]) => name.toLowerCase() !== "x-bun-preview-base");
    if (this.routePrefix) {
      headers.push(["x-bun-preview-base", `${this.routePrefix}${ask.port}/`]);
    }
    const request = {
      method: ask.method,
      target: ask.target,
      headers,
      body: ask.body ? new Uint8Array(ask.body) : null,
    };

    // Primary path: cancelable HTTP/1.1 connection via server.connect().
    let finished = false;
    let dispatched = false;
    let connection: PreviewConnection | null = null;
    const stopConnect = () => {
      if (finished) return;
      finished = true;
      reply.onmessage = null;
      try { connection?.close(); } catch {}
      try { reply.close(); } catch {}
    };
    const sendConnect = (msg: PreviewReply, transfer: Transferable[] = []) => {
      if (finished) return;
      try { reply.postMessage(msg, transfer); } catch { stopConnect(); }
    };
    const finishConnect = (msg: PreviewReply) => {
      if (finished) return;
      sendConnect(msg);
      finished = true;
      reply.onmessage = null;
      try { connection?.close(); } catch {}
      if (dispatched) try { reply.close(); } catch {}
    };
    const parser = new ResponseParser(
      {
        head: (head) => sendConnect({ type: "head", ...head }),
        data: (chunk) => sendConnect({ type: "data", chunk }, [chunk.buffer]),
        end: () => finishConnect({ type: "end" }),
        error: (message) => finishConnect({ type: "error", message }),
      },
      request.method.toUpperCase() === "HEAD",
    );
    connection = server.connect(ask.port, {
      data: (chunk) => { if (!finished) parser.push(chunk); },
      end: () => { if (!finished) parser.end(); },
      error: (message) => finishConnect({ type: "error", message }),
    });
    if (connection) {
      reply.onmessage = (ev: MessageEvent<unknown>) => {
        if (ev.data && typeof ev.data === "object" && "type" in ev.data && ev.data.type === "cancel") {
          stopConnect();
        }
      };
      try {
        connection.write(serializeRequest(request, `localhost:${ask.port}`));
      } catch (err) {
        finishConnect({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      sendConnect({ type: "accepted" });
      dispatched = true;
      if (finished) {
        try { reply.close(); } catch {}
      }
      return;
    }

    // Fallback path: cancel-aware page-side server.request() (never delegates raw reply to super).
    let reqDispatched = false;
    let reqEnded = false;
    let reqCancelled = false;
    const stopRequest = () => {
      if (reqCancelled || reqEnded) return;
      reqCancelled = true;
      reqEnded = true;
      reply.onmessage = null;
      try { reply.close(); } catch {}
    };
    const sendReq = (msg: PreviewReply, transfer: Transferable[] = []) => {
      if (reqCancelled || reqEnded) return;
      try { reply.postMessage(msg, transfer); } catch { stopRequest(); }
    };
    const finishReq = (msg: PreviewReply) => {
      if (reqCancelled || reqEnded) return;
      sendReq(msg);
      reqEnded = true;
      reply.onmessage = null;
      if (reqDispatched) try { reply.close(); } catch {}
    };
    reply.onmessage = (ev: MessageEvent<unknown>) => {
      if (ev.data && typeof ev.data === "object" && "type" in ev.data && ev.data.type === "cancel") {
        stopRequest();
      }
    };
    const accepted = server.request(ask.port, request, {
      head: (head) => sendReq({ type: "head", ...head }),
      data: (chunk) => sendReq({ type: "data", chunk }, [chunk.buffer]),
      end: () => finishReq({ type: "end" }),
      error: (message) => finishReq({ type: "error", message }),
    });
    if (!reqCancelled) {
      sendReq({ type: accepted ? "accepted" : "none" });
      reqDispatched = true;
      if (!accepted || reqEnded) {
        reply.onmessage = null;
        try { reply.close(); } catch {}
      }
    }
  }
}
