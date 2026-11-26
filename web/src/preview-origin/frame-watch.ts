// When the document in one preview frame has settled. A cross-origin frame shows its embedder
// nothing, and its `load` event fires for the initial blank document, the cold-load page and the
// service worker's error pages alike. Three things therefore settle a frame:
//
// - the page's own `load` report (an HTML page carries the shim that sends it);
// - the service worker's error page, which reports that the server did not answer;
// - for a document that cannot report (plain text, an image, a page whose policy keeps the shim
//   out), the frame's `load` event, once a page of the frame's own origin has looked at that very
//   frame and found a loaded document of the server in it.
//
// The IDE page cannot read a preview frame, but the hidden relay page it mounts on the preview
// origin can: frames of one origin under one parent reach each other through `parent.frames`. So
// the answer is about that frame and the document it holds at that moment, not about a response
// that some frame got for the same address.
import { OWN_PAGE_ATTRIBUTE, type FrameDocument, type NavigationAnswer } from "./protocol.js";

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

interface FrameWindow {
  readonly document: { readonly readyState: string; readonly documentElement: { hasAttribute(name: string): boolean } | null };
}

/**
 * What the window `target` returns holds, for a page that may or may not share its origin.
 * Reading another origin's window throws, and so does a frame index that is gone.
 */
export function describeFrame(target: () => FrameWindow | undefined): FrameDocument {
  try {
    const document = target()?.document;
    if (!document) return "unreadable";
    // The cold-load page and the service worker's own answers are not the server's document.
    if (document.documentElement?.hasAttribute(OWN_PAGE_ATTRIBUTE)) return "own";
    return document.readyState === "complete" ? "server" : "loading";
  } catch {
    return "unreadable";
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** `input` without its fragment, or null when it is no URL. */
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
  try { return withoutFragment(new URL(answer.location, answer.url).href); } catch { return null; }
}

/**
 * The one case the relay page cannot settle: a document it cannot read. The server redirected the
 * frame to another origin, or sent a document with an opaque origin (a `sandbox` policy), and no
 * shim report can be trusted from there. Such a load counts only when the server has sent the
 * final response of this frame's current navigation: the response to the frame's address, followed
 * through its redirects. A readable document never takes this path, so the cold-load page and the
 * error pages cannot satisfy it.
 *
 * All state belongs to one address of the frame. A new address, a report from the page and a
 * settled document each start it afresh.
 */
export class UnreadableNavigation {
  private address: string | null = null;
  /** Where a redirect within the preview origins sent the frame. Null: the address itself. */
  private redirected: string | null = null;
  /** The final response of the chain went out, or a redirect took the frame off the preview origins. */
  private answered = false;
  /** An unreadable document loaded while another tab's answer may still be on its way. */
  private loaded = false;

  /** `isPreview`: whether a URL is on a preview origin, where a further response can be heard of. */
  constructor(private readonly isPreview: (url: string) => boolean) {}

  /** Forgets what was learned: a new navigation of the frame starts. */
  restart(): void {
    this.redirected = null;
    this.answered = false;
    this.loaded = false;
  }

  private at(address: string | null): void {
    if (address === this.address) return;
    this.address = address;
    this.restart();
  }

  /** A server's response head for the navigation of some frame. True when it settles this frame, now at `address`. */
  answer(answer: NavigationAnswer, address: string | null): boolean {
    this.at(address);
    if (address === null || this.answered || withoutFragment(answer.url) !== (this.redirected ?? address)) return false;
    const target = redirectTarget(answer);
    if (target !== null && this.isPreview(target)) {
      this.redirected = target;
      return false;
    }
    this.answered = true;
    if (!this.loaded) return false;
    this.restart();
    return true;
  }

  /**
   * An unreadable document loaded in the frame, now at `address`. True when it settles the frame.
   * `hearsFirst`: this tab runs the server and so hears each answer before the document can load;
   * another tab's answer travels on its own channel and may arrive after it.
   */
  unreadable(address: string, hearsFirst: boolean): boolean {
    this.at(address);
    if (!this.answered) {
      this.loaded = !hearsFirst;
      return false;
    }
    this.restart();
    return true;
  }
}

/** Where `frame` sits among the frames of this page (`window.frames`), or -1. */
export function frameIndex(frame: HTMLIFrameElement): number {
  const target = frame.contentWindow;
  if (!target) return -1;
  for (let index = 0; index < window.frames.length; index++) {
    if (window.frames[index] === target) return index;
  }
  return -1;
}
