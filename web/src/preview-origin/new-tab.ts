// New tabs the app itself opens. A tab on the preview origin is outside the IDE and gets the
// "open it from the IDE" page, so a same-origin `target="_blank"` link (a report, a print view) or
// `window.open` call is pointed at the IDE's wrapper page for that URL instead. The browser still
// performs its own click or open, so user activation, background tabs and `rel` work as usual.
import { wrapperLink } from "./protocol";

/** Whether a link or `window.open` target names a new browsing context, given the names of the frames in reach. */
export function namesNewTab(target: string, frameNamed: (name: string) => boolean): boolean {
  const name = target.toLowerCase();
  if (name === "" || name === "_self" || name === "_parent" || name === "_top") return false;
  return name === "_blank" || !frameNamed(target);
}

/** A click that the browser opens in a new tab or window whatever the link's target says. */
export function opensAside(event: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  return event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey;
}

/**
 * The wrapper page's URL for a new-tab destination, or null when the destination is not a page of
 * this origin: another site, `about:blank`, a `blob:` or `data:` URL all open as the app wrote them.
 */
export function newTabLink(wrapper: string, destination: string | URL | undefined, base: string, origin: string): string | null {
  if (destination === undefined || destination === "") return null;
  let url: URL;
  try { url = new URL(String(destination), base); } catch { return null; }
  if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  return wrapperLink(wrapper, url.href);
}

function frameNamed(name: string): boolean {
  if (window.name === name) return true;
  return Array.from(document.querySelectorAll("iframe[name], frame[name], object[name]")).some(frame => frame.getAttribute("name") === name);
}

function clickedLink(event: MouseEvent): HTMLAnchorElement | HTMLAreaElement | undefined {
  return event.composedPath().find((node): node is HTMLAnchorElement | HTMLAreaElement =>
    (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.hasAttribute("href"));
}

/** Points the link at `link` for the browser's own activation, which follows this event in the same task. */
function redirectOnce(anchor: HTMLAnchorElement | HTMLAreaElement, link: string): void {
  const written = anchor.getAttribute("href");
  anchor.setAttribute("href", link);
  setTimeout(() => {
    // The app may have changed the link meanwhile; only this function's own value is taken back.
    if (written !== null && anchor.getAttribute("href") === link) anchor.setAttribute("href", written);
  }, 0);
}

/** `wrapper`: the IDE-origin page that shows a preview URL of this origin, as the IDE tab named it. */
export function installNewTabs(wrapper: string): void {
  const nativeOpen = window.open;
  window.open = function (this: Window, url?: string | URL, target?: string, features?: string): WindowProxy | null {
    const link = namesNewTab(target ?? "_blank", frameNamed) ? newTabLink(wrapper, url, document.baseURI, location.origin) : null;
    return nativeOpen.call(this, link ?? url, target, features);
  };
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    const anchor = clickedLink(event);
    if (!anchor || anchor.hasAttribute("download")) return;
    const target = anchor.target || document.querySelector<HTMLBaseElement>("base[target]")?.target || "";
    if (!opensAside(event) && !namesNewTab(target, frameNamed)) return;
    const link = newTabLink(wrapper, anchor.href, document.baseURI, location.origin);
    if (link) redirectOnce(anchor, link);
  };
  // Capture on the window: this runs before the app's own listeners, and they cannot stop it.
  addEventListener("click", onClick, true);
  addEventListener("auxclick", onClick, true);
}
