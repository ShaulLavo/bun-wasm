import { afterEach, expect, test } from "bun:test";
import { describeFrame, frameIndex } from "../src/preview-origin/frame-watch";
import { OWN_PAGE_ATTRIBUTE } from "../src/preview-origin/protocol";

/** A window as the relay page reads a frame of its own origin. */
const holding = (readyState: string, attributes: string[] = []) => ({
  document: { readyState, documentElement: { hasAttribute: (name: string) => attributes.includes(name) } },
});

test("a loaded document of the server is told apart from the origin's own pages and from one still loading", () => {
  expect(describeFrame(() => holding("complete"))).toBe("server");
  // Plain text and images get a synthesized document; an XML document may have no root yet.
  expect(describeFrame(() => ({ document: { readyState: "complete", documentElement: null } }))).toBe("server");
  // The cold-load page and the service worker's error pages carry the marker: their load settles nothing.
  expect(describeFrame(() => holding("complete", [OWN_PAGE_ATTRIBUTE]))).toBe("own");
  expect(describeFrame(() => holding("loading", [OWN_PAGE_ATTRIBUTE]))).toBe("own");
  // The body of the final response is still arriving.
  expect(describeFrame(() => holding("loading"))).toBe("loading");
  expect(describeFrame(() => holding("interactive"))).toBe("loading");
});

test("a frame of another origin, a blank frame and a frame that is gone are unreadable", () => {
  // Reading a cross-origin window's document throws, as does the blank document of the IDE's own origin.
  expect(describeFrame(() => ({ get document(): never { throw new DOMException("Blocked a frame", "SecurityError"); } }))).toBe("unreadable");
  expect(describeFrame(() => { throw new DOMException("Blocked a frame", "SecurityError"); })).toBe("unreadable");
  expect(describeFrame(() => undefined)).toBe("unreadable");
});

const saved = Reflect.get(globalThis, "window");
afterEach(() => { Object.assign(globalThis, { window: saved }); });

test("a frame is named by its place among the page's frames, and a frame outside the page has none", () => {
  const windows = [{}, {}, {}];
  Object.assign(globalThis, { window: { frames: windows } });
  const frame = (contentWindow: unknown) => ({ contentWindow }) as HTMLIFrameElement;
  expect(frameIndex(frame(windows[0]))).toBe(0);
  expect(frameIndex(frame(windows[2]))).toBe(2);
  expect(frameIndex(frame({}))).toBe(-1);
  expect(frameIndex(frame(null))).toBe(-1);
});
