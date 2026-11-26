// The IDE-origin page behind "open the preview in a new tab". A top-level tab on the preview
// origin cannot reach the IDE tab's relay in every browser, but a frame inside an IDE-origin tab
// shares the preview origin's service worker with the IDE tab, so the link opens this page.
import { frameMessage, isPreviewOrigin, type PreviewOriginConfig } from "./protocol.js";

const RETRIES = 4;

function fail(message: string): void {
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = message;
  document.body.replaceChildren(status);
}

function targetUrl(config: PreviewOriginConfig | null): URL | null {
  const requested = new URLSearchParams(location.search).get("url");
  if (!config || !requested) return null;
  let url: URL;
  try { url = new URL(requested); } catch { return null; }
  return isPreviewOrigin(url.origin, config) ? url : null;
}

/**
 * Fills this page with the preview its `url` parameter names. Only a preview origin of `config`
 * is ever framed, so the page cannot be made to frame anything else.
 */
export function showPreviewFrame(config: PreviewOriginConfig | null): void {
  // A preview may have opened this tab (its own `window.open` or link). This page is the IDE's: it keeps no way back to its opener.
  try { window.opener = null; } catch { /* Nothing to cut. */ }
  const target = targetUrl(config);
  if (!target) { fail("This link does not name a preview of this IDE."); return; }
  const frame = document.createElement("iframe");
  frame.title = "App preview";
  frame.allow = "cross-origin-isolated";
  frame.src = target.href;
  let retries = 0;
  addEventListener("message", event => {
    if (event.source !== frame.contentWindow || event.origin !== target.origin) return;
    const message = frameMessage(event.data);
    if (!message) return;
    if (message.event === "error") {
      // The IDE tab may still be attaching its relay.
      if (message.transient && retries < RETRIES) setTimeout(() => { frame.src = target.href; }, 500 * ++retries);
      return;
    }
    retries = 0;
    if (message.title) document.title = message.title;
    let current: URL;
    try { current = new URL(message.href); } catch { return; }
    if (current.origin !== target.origin) return;
    // Reloading this tab returns to where the preview is now.
    const here = new URL(location.href);
    here.searchParams.set("url", current.href);
    history.replaceState(null, "", here);
  });
  document.body.replaceChildren(frame);
}
