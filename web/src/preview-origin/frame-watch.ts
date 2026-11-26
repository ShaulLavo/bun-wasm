// When the document in one preview frame has settled. A cross-origin frame shows its embedder
// nothing, and its `load` event fires for the initial blank document, the cold-load page and the
// service worker's error pages alike. Three things therefore settle a frame:
//
// - the page's own `load` report (an HTML page carries the shim that sends it);
// - the service worker's error page, which reports that the server did not answer;
// - for a document that cannot report (plain text, an image, a page whose policy keeps the shim
//   out), the frame's `load` event, but only once the server has sent the final response to this
//   frame's own navigation: the response to the frame's address, followed through its redirects.
//
// The tab that runs the server sees each response head before the document can load. Another tab
// of the workspace hears of it on a BroadcastChannel, which may arrive after the document did.
import type { FrameMessage, NavigationAnswer } from "./protocol.js";

/** What became of the document in a watched preview frame. Either callback may be called again for later documents. */
export interface FrameWatch {
  /**
   * A document of the server finished loading. `href` is its address when the document said so
   * itself, and null when it could not: plain text, an image, a page whose policy keeps the shim out.
   */
  loaded(href: string | null): void;
  /** The service worker answered in the server's place. A transient failure is worth another try. */
  failed(transient: boolean): void;
}

export interface FrameWatchSource {
  /** The preview URL the frame was sent to (its `src`), without a fragment; null while it has none. */
  address(): string | null;
  /** Whether `url` is on a preview origin: only there can a response be heard of. */
  isPreview(url: string): boolean;
  /** Whether this tab runs the server of `url`, and so hears its answers before the document loads. */
  runsServer(url: string): boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function withoutFragment(input: string): string | null {
  try {
    const url = new URL(input);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Where a redirect answer sends the frame, or null when the answer is a final response. */
function redirectTarget(answer: NavigationAnswer): string | null {
  if (!REDIRECTS.has(answer.status) || answer.location === null) return null;
  try {
    const target = new URL(answer.location, answer.url);
    target.hash = "";
    return target.href;
  } catch {
    return null;
  }
}

export class FrameWatcher {
  /** Where a redirect sent the frame. Null: the frame's own address. */
  private redirected: string | null = null;
  /**
   * `answered`: the server sent the final response of this frame's navigation, so the next `load`
   * is its document's. `left`: a redirect took the frame off the preview origins, where nothing
   * more can be learned; its next `load` ends the wait.
   */
  private state: "waiting" | "answered" | "left" = "waiting";
  /** A document loaded while another tab's answer was still on its way. */
  private loadedUnanswered = false;

  constructor(private readonly source: FrameWatchSource, private readonly watch: FrameWatch) {}

  private awaited(): string | null {
    return this.redirected ?? this.source.address();
  }

  private restart(): void {
    this.redirected = null;
    this.state = "waiting";
    this.loadedUnanswered = false;
  }

  private settle(): void {
    this.restart();
    this.watch.loaded(null);
  }

  /** A server's response head for the navigation of some frame. Only this frame's own navigation counts. */
  answered(answer: NavigationAnswer): void {
    const awaited = this.awaited();
    if (this.state !== "waiting" || awaited === null || withoutFragment(answer.url) !== awaited) return;
    const target = redirectTarget(answer);
    if (target !== null) {
      this.redirected = target;
      if (!this.source.isPreview(target)) this.state = "left";
      return;
    }
    this.state = "answered";
    if (this.loadedUnanswered) this.settle();
  }

  /** The frame element's trusted `load` event. */
  frameLoaded(): void {
    const awaited = this.awaited();
    // The initial blank document of a frame that has no address yet says nothing.
    if (awaited === null) return;
    if (this.state !== "waiting") { this.settle(); return; }
    if (!this.source.runsServer(awaited)) this.loadedUnanswered = true;
  }

  /** What the document in the frame said about itself. */
  reported(message: FrameMessage): void {
    if (message.event === "commit") return;
    this.restart();
    if (message.event === "load") this.watch.loaded(message.href);
    else this.watch.failed(message.transient === true);
  }
}
