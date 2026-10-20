import type { Page } from "playwright";

type SocketObservation = { url: string; type: string; data: string | null };
declare global { var nextFrameworkSocketEvents: SocketObservation[]; }

function observeSocketDispatch() {
  const events: SocketObservation[] = [];
  globalThis.nextFrameworkSocketEvents = events;
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event: Event): boolean {
    if (this instanceof WebSocket) {
      events.push({ url: this.url, type: event.type, data: event instanceof MessageEvent ? String(event.data) : null });
    }
    return dispatch.call(this, event);
  };
}

export async function observePreviewSockets(page: Page): Promise<void> {
  await page.addInitScript(observeSocketDispatch);
}

export async function previewSocketEvents(page: Page): Promise<SocketObservation[]> {
  return page.evaluate(() => globalThis.nextFrameworkSocketEvents);
}
