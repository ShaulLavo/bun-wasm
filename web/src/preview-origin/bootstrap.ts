// The page the static host answers a framed navigation with when no service worker controlled it
// (a cold load, a forced reload, an evicted worker). It registers the worker, then tries one
// ordinary navigation. A forced reload leaves `navigator.serviceWorker.controller` null for the
// whole document, so this never waits for a controller.
import { FRAME_MESSAGE, SW_PATH } from "./protocol";

const COUNTER = "bunwasm-preview-bootstrap";

function show(message: string): void {
  const status = document.querySelector("[role=status]");
  if (status) status.textContent = message;
  if (parent !== window) parent.postMessage({ type: FRAME_MESSAGE, event: "error", href: location.href, transient: false }, "*");
}

function attempts(): number {
  try { return Number(sessionStorage.getItem(COUNTER) ?? 0); } catch { return 0; }
}

async function start(): Promise<void> {
  if (top === window) { show("This preview only works inside its IDE tab. Open it from the IDE."); return; }
  if (!navigator.serviceWorker) { show("Service workers are off in this browser window, so the preview cannot load."); return; }
  const tried = attempts();
  if (tried >= 2) { show("The preview's service worker did not take control of this frame. Reload the IDE page."); return; }
  await navigator.serviceWorker.register(SW_PATH, { scope: "/", updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  try { sessionStorage.setItem(COUNTER, String(tried + 1)); } catch { /* Without storage the count stays at zero; the worker then serves the retry. */ }
  location.replace(location.href);
}

start().catch(error => show(`The preview could not start: ${String(error)}`));
