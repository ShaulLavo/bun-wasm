// The relay page: a hidden frame of the preview origin inside the IDE page. It registers the
// origin's service worker and passes the IDE's MessagePort on to it. It never reads the port: the
// port, not this page, is the capability.
//
// It also tells the IDE page what one of that page's frames holds (frame-watch.ts): this page
// shares the preview's origin, so it can look where the IDE page cannot. An IDE tab that only
// shows another tab's server mounts it with `?inspect` for that alone.
import { describeFrame } from "./frame-watch";
import { RELAY_INSPECT_QUERY, RELAY_MESSAGE, SW_ATTACH, SW_NEED_PORT, SW_PATH, relayMessage, type RelayEvent, type RelayMessage } from "./protocol";

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
  if (parent === window || allowed.length === 0) return;
  const inspectOnly = location.search === RELAY_INSPECT_QUERY;
  let forwarding: Promise<unknown> = Promise.resolve();
  addEventListener("message", event => {
    if (event.source !== parent || !allowed.includes(event.origin)) return;
    const message = relayMessage(event.data);
    if (message?.event === "inspect") {
      const document = describeFrame(() => parent.frames[message.index]);
      parent.postMessage({ type: RELAY_MESSAGE, event: "inspected", id: message.id, document } satisfies RelayMessage, event.origin);
      return;
    }
    const port = event.ports[0];
    if (inspectOnly || !container || message?.event !== "attach" || !port) return;
    // The worker may have been replaced since this page loaded, so each port goes to the current
    // one, and ports go out in the order they came in.
    forwarding = forwarding.then(worker).then(active => active.postMessage({ type: SW_ATTACH }, [port])).catch(() => {});
  });
  if (inspectOnly) { tell("ready"); return; }
  if (!container) return;
  container.addEventListener("message", event => {
    if ((event.data as { type?: unknown } | null)?.type === SW_NEED_PORT) tell("need-port");
  });
  container.startMessages();
  await worker();
  tell("ready");
}

void start();
