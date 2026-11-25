// The relay page: a hidden frame of the preview origin inside the IDE page. It registers the
// origin's service worker and passes the IDE's MessagePort on to it. It never reads the port: the
// port, not this page, is the capability.
import { RELAY_MESSAGE, SW_ATTACH, SW_NEED_PORT, SW_PATH, relayMessage, type RelayEvent } from "./protocol";

const REGISTER_ATTEMPTS = 3;

/** The static host writes the allowed IDE origins into the page (host.ts). */
function ideOrigins(): string[] {
  const value: unknown = Reflect.get(globalThis, "__bunwasmPreviewIdeOrigins");
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const allowed = ideOrigins();
const container = navigator.serviceWorker;

/** Only an allowed IDE origin receives it: the browser drops a message whose target origin differs. */
function tell(event: RelayEvent): void {
  for (const origin of allowed) parent.postMessage({ type: RELAY_MESSAGE, event }, origin);
}

/** Resolves with the registration's activated worker, or null when its newest worker was discarded. */
function activeWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const check = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", check);
      resolve(worker.state === "activated" ? worker : registration.active);
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

/** Registers the worker and waits until one is active. An install that fails is tried again. */
async function worker(): Promise<ServiceWorker> {
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
    const registration = await container.register(SW_PATH, { scope: "/", updateViaCache: "none" });
    const active = await activeWorker(registration);
    if (active) return active;
  }
  throw new Error("The preview service worker did not activate");
}

async function start(): Promise<void> {
  if (parent === window || !container || allowed.length === 0) return;
  addEventListener("message", event => {
    if (event.source !== parent || !allowed.includes(event.origin)) return;
    const port = event.ports[0];
    if (relayMessage(event.data)?.event !== "attach" || !port) return;
    // The worker may have been replaced since this page loaded, so each port goes to the current one.
    void worker().then(active => active.postMessage({ type: SW_ATTACH }, [port]));
  });
  container.addEventListener("message", event => {
    if ((event.data as { type?: unknown } | null)?.type === SW_NEED_PORT) tell("need-port");
  });
  container.startMessages();
  await worker();
  tell("ready");
}

void start();
