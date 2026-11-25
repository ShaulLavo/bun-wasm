// Attach-only worker identity observer. No-op unless spawned with `#attach:<workerInstanceId>`.
const PEER_CHANNEL = "bun-wasm:fs-worker-peer";
const PEER_ALIVE_PREFIX = "waffle:multitab:v1:peer-alive:";

function installAttachObserver(): void {
  const hash = typeof self !== "undefined" ? self.location?.hash : undefined;
  if (!hash || !hash.startsWith("#attach:")) return;
  if (typeof BroadcastChannel !== "function") return;
  const locks = self.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return;

  const workerInstanceId = hash.slice("#attach:".length);
  if (!workerInstanceId) return;

  let workerClientId: string | null = null;
  let peerAliveLock: string | null = null;
  const channel = new BroadcastChannel(PEER_CHANNEL);

  const announce = () => {
    try {
      channel.postMessage({
        type: "fs-worker-identity",
        tabId: workerInstanceId,
        workerClientId,
        peerAliveLock,
      });
    } catch {
      // Ignore closed channel during worker termination.
    }
  };

  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; tabId?: unknown } | null;
    if (data && data.type === "query-fs-worker-identity" && data.tabId === workerInstanceId) {
      announce();
    }
  };

  // Wrap locks.request strictly to observe Waffle's exclusive peer-alive lock (never shared watchers).
  const originalRequest = locks.request.bind(locks);
  locks.request = (function wrappedLockRequest(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
    maybeCallback?: LockGrantedCallback<unknown>,
  ) {
    const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
    const mode = options?.mode ?? "exclusive";
    if (name.startsWith(PEER_ALIVE_PREFIX) && mode === "exclusive") {
      if (peerAliveLock !== name) {
        peerAliveLock = name;
        announce();
      }
    }
    if (typeof optionsOrCallback === "function") {
      return originalRequest(name, optionsOrCallback);
    }
    return originalRequest(name, optionsOrCallback, maybeCallback!);
  }) as LockManager["request"];

  // Lightweight startup probe to capture this worker realm's exact Web Locks clientId.
  const probeLock = `bun-wasm:fs-worker-init:${workerInstanceId}`;
  void originalRequest(probeLock, async () => {
    try {
      const snapshot = await locks.query();
      const held = snapshot.held?.find((entry) => entry.name === probeLock);
      if (held?.clientId) {
        workerClientId = held.clientId;
        announce();
      }
    } catch {
      // Ignore query errors during teardown.
    }
  }).catch(() => {});
}

installAttachObserver();
