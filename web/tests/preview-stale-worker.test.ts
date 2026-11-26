import { afterEach, expect, test } from "bun:test";
import type { PreviewServer } from "waffle/browser/preview";
import { Previews } from "../src/preview";
import { activeWorker } from "../src/preview-origin/relay";

const EXPECTED_SCRIPT = "https://example.test/sw.js";

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly scriptURL: string;
  readonly posted: unknown[] = [];

  constructor(state: ServiceWorkerState = "installing", scriptURL = EXPECTED_SCRIPT) {
    super();
    this.state = state;
    this.scriptURL = scriptURL;
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(message);
    const port = (transfer ?? []).find((item): item is MessagePort => item instanceof MessagePort);
    if (!port || !message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "preview-register" || message.type === "preview-register-all") {
      port.postMessage({ type: "preview-register-ack" });
    }
  }
}

interface MutableRegistration extends EventTarget {
  installing: FakeServiceWorker | null;
  waiting: FakeServiceWorker | null;
  active: FakeServiceWorker | null;
}

function makeRegistration(slots: Partial<Pick<MutableRegistration, "installing" | "waiting" | "active">> = {}): MutableRegistration {
  const reg = new EventTarget() as MutableRegistration;
  reg.installing = slots.installing ?? null;
  reg.waiting = slots.waiting ?? null;
  reg.active = slots.active ?? null;
  return reg;
}

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

function installFakeServiceWorker(registration: MutableRegistration): void {
  const container = new EventTarget();
  Object.assign(container, {
    startMessages() {},
    register: async () => registration as unknown as ServiceWorkerRegistration,
  });
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  Object.defineProperty(globalThis, "location", { value: new URL("https://example.test/"), configurable: true });
}

afterEach(() => {
  if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete (globalThis as Record<string, unknown>).location;
});

const dummyServer = (): PreviewServer => ({
  request: () => false,
  connect: () => null,
});

test("Previews accepts a non-redundant active worker whose state never updates (WebKit stale-installing bug)", async () => {
  for (const state of ["installing", "installed", "activating", "activated"] as const) {
    const worker = new FakeServiceWorker(state);
    installFakeServiceWorker(makeRegistration({ active: worker }));
    const previews = new Previews({ baseURL: "https://example.test/", prefix: "__preview", route: "ws-stale" });
    try {
      expect(await previews.ready).toBe("ready");
      const token = previews.registerListener(5173, dummyServer());
      expect(await previews.waitUntilRegistered(5173, token)).toBe("ready");
      expect(previews.isListenerReady(5173, token)).toBe(true);
      expect(worker.posted.length).toBeGreaterThanOrEqual(1);
    } finally {
      await previews.dispose();
    }
  }
});

test("Previews rejects a redundant active worker and drops readiness if it becomes redundant later", async () => {
  const redundant = new FakeServiceWorker("redundant");
  installFakeServiceWorker(makeRegistration({ active: redundant }));
  const failedPreviews = new Previews({ baseURL: "https://example.test/", prefix: "__preview", route: "ws-redundant" });
  try {
    expect(await failedPreviews.ready).toBe("failed");
    const token = failedPreviews.registerListener(5173, dummyServer());
    expect(await failedPreviews.waitUntilRegistered(5173, token)).toBe("failed");
    expect(failedPreviews.isListenerReady(5173, token)).toBe(false);
  } finally {
    await failedPreviews.dispose();
  }

  const worker = new FakeServiceWorker("installing");
  installFakeServiceWorker(makeRegistration({ active: worker }));
  const livePreviews = new Previews({ baseURL: "https://example.test/", prefix: "__preview", route: "ws-retire" });
  try {
    const token = livePreviews.registerListener(5173, dummyServer());
    expect(await livePreviews.waitUntilRegistered(5173, token)).toBe("ready");
    expect(livePreviews.isListenerReady(5173, token)).toBe(true);
    worker.state = "redundant";
    expect(livePreviews.isListenerReady(5173, token)).toBe(false);
  } finally {
    await livePreviews.dispose();
  }
});

test("Previews still waits for an expected script upgrade while an older active worker is present", async () => {
  const oldWorker = new FakeServiceWorker("installing", "https://example.test/sw-old.js");
  const nextWorker = new FakeServiceWorker("installing", EXPECTED_SCRIPT);
  const reg = makeRegistration({ active: oldWorker, installing: nextWorker });
  installFakeServiceWorker(reg);
  const previews = new Previews({ baseURL: "https://example.test/", prefix: "__preview", route: "ws-upgrade" });
  try {
    let settled = false;
    const ready = previews.ready.then((state) => {
      settled = true;
      return state;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);

    reg.installing = null;
    reg.active = nextWorker;
    nextWorker.state = "activated";
    nextWorker.dispatchEvent(new Event("statechange"));
    expect(await ready).toBe("ready");
    expect(nextWorker.posted.length).toBeGreaterThanOrEqual(1);
    expect(oldWorker.posted.length).toBe(0);
  } finally {
    await previews.dispose();
  }
});

test("preview-origin relay activeWorker accepts a stale active worker and rejects redundant ones", async () => {
  for (const state of ["installing", "installed", "activating", "activated"] as const) {
    const worker = new FakeServiceWorker(state);
    const reg = makeRegistration({ active: worker }) as unknown as ServiceWorkerRegistration;
    expect(await activeWorker(reg)).toBe(worker as unknown as ServiceWorker);
  }

  const redundant = new FakeServiceWorker("redundant");
  expect(await activeWorker(makeRegistration({ active: redundant }) as unknown as ServiceWorkerRegistration)).toBeNull();
  expect(await activeWorker(makeRegistration() as unknown as ServiceWorkerRegistration)).toBeNull();

  // An installing upgrade is still awaited while an older worker is active.
  const current = new FakeServiceWorker("installing");
  const next = new FakeServiceWorker("installing");
  const upgrading = makeRegistration({ active: current, installing: next });
  let settled = false;
  const pending = activeWorker(upgrading as unknown as ServiceWorkerRegistration).then((worker) => {
    settled = true;
    return worker;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  next.state = "activated";
  next.dispatchEvent(new Event("statechange"));
  expect(await pending).toBe(next as unknown as ServiceWorker);

  // A discarded upgrade falls back to a non-redundant active worker, never to a redundant one.
  const discarded = new FakeServiceWorker("installing");
  const fallback = new FakeServiceWorker("installing");
  const fallbackReg = makeRegistration({ active: fallback, installing: discarded });
  const fallbackPromise = activeWorker(fallbackReg as unknown as ServiceWorkerRegistration);
  discarded.state = "redundant";
  discarded.dispatchEvent(new Event("statechange"));
  expect(await fallbackPromise).toBe(fallback as unknown as ServiceWorker);

  const discarded2 = new FakeServiceWorker("installing");
  const redundantFallback = new FakeServiceWorker("redundant");
  const emptyReg = makeRegistration({ active: redundantFallback, installing: discarded2 });
  const emptyPromise = activeWorker(emptyReg as unknown as ServiceWorkerRegistration);
  discarded2.state = "redundant";
  discarded2.dispatchEvent(new Event("statechange"));
  expect(await emptyPromise).toBeNull();
});
