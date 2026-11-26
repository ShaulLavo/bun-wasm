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
import { OWN_PAGE_ATTRIBUTE, type FrameDocument } from "./protocol.js";

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

/** Where `frame` sits among the frames of this page (`window.frames`), or -1. */
export function frameIndex(frame: HTMLIFrameElement): number {
  const target = frame.contentWindow;
  if (!target) return -1;
  for (let index = 0; index < window.frames.length; index++) {
    if (window.frames[index] === target) return index;
  }
  return -1;
}
