import type { Terminal } from "@xterm/xterm";
import { linkLocalUrls } from "../terminal-links";

/** Browser brand only; Chrome and other browsers also include Safari in their UA. */
export function isSafari(userAgent: string): boolean {
  return /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)
    && !/Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|OPR|OPiOS|Android/.test(userAgent);
}

type Previews = Parameters<typeof linkLocalUrls>[1];

function registeredPreview(uri: string, previews: Previews, ports: ReadonlySet<number>): boolean {
  let url: URL;
  try { url = new URL(uri); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  for (const port of ports) {
    if (!previews.serves(port)) continue;
    const base = new URL(previews.url(port));
    if (url.origin === base.origin && url.pathname.startsWith(base.pathname)) return true;
  }
  return false;
}

/** Both xterm link sources share one owned in-page presentation on Safari. */
export function installPreviewLinks(term: Terminal, previews: Previews, ports: ReadonlySet<number>, returnToEditor: () => void): () => void {
  const lifetime = new AbortController();
  const embedded = isSafari(navigator.userAgent);
  let current: { url: string; pane: HTMLElement; frame: HTMLIFrameElement; lifetime: AbortController } | undefined;

  function close(restoreFocus: boolean): void {
    if (!current) return;
    current.lifetime.abort();
    current.pane.remove();
    current = undefined;
    if (restoreFocus) returnToEditor();
  }

  function present(url: string): void {
    if (current?.url === url) { current.frame.focus(); return; }
    close(false);
    const pane = document.createElement("section");
    pane.className = "pane playground-preview";
    pane.setAttribute("aria-label", "Preview");
    const bar = document.createElement("div");
    bar.className = "bar";
    const address = document.createElement("span");
    address.className = "preview-address";
    address.textContent = url;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Close preview";
    const frame = document.createElement("iframe");
    frame.title = "App preview";
    frame.src = url;
    const frameLifetime = new AbortController();
    const signal = frameLifetime.signal;
    button.addEventListener("click", () => close(true), { signal });
    pane.addEventListener("keydown", event => { if (event.key === "Escape") close(true); }, { signal });
    frame.addEventListener("load", () => {
      if (document.activeElement === button || document.activeElement === term.textarea) frame.focus();
    }, { once: true, signal });
    bar.appendChild(address);
    bar.appendChild(button);
    pane.appendChild(bar);
    pane.appendChild(frame);
    current = { url, pane, frame, lifetime: frameLifetime };
    document.body.appendChild(pane);
    button.focus();
  }

  function activate(uri: string): void {
    if (lifetime.signal.aborted) return;
    if (embedded && registeredPreview(uri, previews, ports)) present(uri);
    else window.open(uri, "_blank", "noopener");
  }

  const previous = term.options.linkHandler;
  const handler = { activate: (_event: MouseEvent, uri: string) => activate(uri), allowNonHttpProtocols: false };
  term.options.linkHandler = handler;
  const links = linkLocalUrls(term, previews, activate);
  function dispose(): void {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    close(false);
    links.dispose();
    if (term.options.linkHandler === handler) term.options.linkHandler = previous;
  }
  window.addEventListener("pagehide", event => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
  return dispose;
}
