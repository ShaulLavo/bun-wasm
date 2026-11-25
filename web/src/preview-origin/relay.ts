// The relay page: a hidden frame of the preview origin inside the IDE page. It registers the
// origin's service worker and passes the IDE's MessagePort on to it. It never reads the port: the
// port, not this page, is the capability.
import { RELAY_MESSAGE, SW_ATTACH, SW_NEED_PORT, SW_PATH, relayMessage, type RelayEvent } from "./protocol";

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

function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker || worker.state === "activated") return Promise.resolve();
  return new Promise(resolve => {
    worker.addEventListener("statechange", () => { if (worker.state === "activated" || worker.state === "redundant") resolve(); });
  });
}

async function forward(port: MessagePort): Promise<void> {
  const registration = await container.ready;
  await activated(registration);
  registration.active?.postMessage({ type: SW_ATTACH }, [port]);
}

async function start(): Promise<void> {
  if (parent === window || !container || allowed.length === 0) return;
  addEventListener("message", event => {
    if (event.source !== parent || !allowed.includes(event.origin)) return;
    const port = event.ports[0];
    if (relayMessage(event.data)?.event !== "attach" || !port) return;
    void forward(port);
  });
  container.addEventListener("message", event => {
    if ((event.data as { type?: unknown } | null)?.type === SW_NEED_PORT) tell("need-port");
  });
  container.startMessages();
  const registration = await container.register(SW_PATH, { scope: "/", updateViaCache: "none" });
  await activated(registration);
  tell("ready");
}

void start();
