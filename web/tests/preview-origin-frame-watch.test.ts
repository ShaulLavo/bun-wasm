import { afterEach, expect, test } from "bun:test";
import { describeFrame, frameIndex, UnreadableNavigation } from "../src/preview-origin/frame-watch";
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

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.shaulavo.dev`;
const OTHER_PORT = `https://${"a".repeat(52)}-3000-pv.shaulavo.dev`;
const ok = (url: string) => ({ url, status: 200, location: null });
const redirect = (url: string, location: string, status = 302) => ({ url, status, location });
const tracker = () => new UnreadableNavigation(url => url.startsWith(ORIGIN) || url.startsWith(OTHER_PORT));

test("an unreadable document settles only after the final response of the frame's own navigation", () => {
  const navigation = tracker();
  const address = `${ORIGIN}/sandboxed`;
  // A browser error page, or a document of some other navigation: the server answered nothing for this one.
  expect(navigation.unreadable(address, true)).toBe(false);
  // Another address, another port's page, a frame without an address: not this frame's navigation.
  expect(navigation.answer(ok(`${ORIGIN}/`), address)).toBe(false);
  expect(navigation.answer(ok(`${OTHER_PORT}/sandboxed`), address)).toBe(false);
  expect(navigation.answer(ok(address), null)).toBe(false);
  expect(navigation.unreadable(address, true)).toBe(false);
  // The server sent the document (its policy gives it an opaque origin): its load settles the frame, once.
  expect(navigation.answer(ok(`${address}#top`), address)).toBe(false);
  expect(navigation.unreadable(address, true)).toBe(true);
  expect(navigation.unreadable(address, true)).toBe(false);
});

test("a redirect is followed to its end, and a redirect off the preview origins ends the wait at the next load", () => {
  const navigation = tracker();
  const address = `${ORIGIN}/old`;
  expect(navigation.answer(redirect(address, "/login?next=%2Fold"), address)).toBe(false);
  // A redirect is no document, and the first address is no longer what is awaited.
  expect(navigation.unreadable(address, true)).toBe(false);
  expect(navigation.answer(ok(address), address)).toBe(false);
  expect(navigation.unreadable(address, true)).toBe(false);
  expect(navigation.answer(redirect(`${ORIGIN}/login?next=%2Fold`, `${OTHER_PORT}/sso#token`, 307), address)).toBe(false);
  expect(navigation.answer(ok(`${OTHER_PORT}/sso`), address)).toBe(false);
  expect(navigation.unreadable(address, true)).toBe(true);
  // The server sends the frame to another site: nothing more can be heard, and its next load is the end.
  const away = `${ORIGIN}/out`;
  expect(navigation.answer(redirect(away, "https://example.com/landing"), away)).toBe(false);
  expect(navigation.unreadable(away, true)).toBe(true);
});

test("a new address, a new start and a report from the page leave no answer or load behind", () => {
  const navigation = tracker();
  // The redirect of the first address never finished; the frame goes elsewhere.
  expect(navigation.answer(redirect(`${ORIGIN}/old`, "/login"), `${ORIGIN}/old`)).toBe(false);
  expect(navigation.answer(ok(`${ORIGIN}/login`), `${ORIGIN}/sandboxed`)).toBe(false);
  expect(navigation.unreadable(`${ORIGIN}/sandboxed`, true)).toBe(false);
  expect(navigation.answer(ok(`${ORIGIN}/sandboxed`), `${ORIGIN}/sandboxed`)).toBe(false);
  // Answered, then replaced before its document loaded: the answer does not serve the next navigation.
  expect(navigation.unreadable(`${ORIGIN}/next`, true)).toBe(false);
  expect(navigation.answer(ok(`${ORIGIN}/sandboxed`), `${ORIGIN}/sandboxed`)).toBe(false);
  navigation.restart();
  expect(navigation.unreadable(`${ORIGIN}/sandboxed`, true)).toBe(false);
});

test("a tab that hears another tab's answers settles when both the answer and the unreadable load have come", () => {
  const address = `${ORIGIN}/sandboxed`;
  const first = tracker();
  expect(first.answer(ok(address), address)).toBe(false);
  expect(first.unreadable(address, false)).toBe(true);
  // The other tab's word travels on its own channel and may arrive after the document did.
  const second = tracker();
  expect(second.unreadable(address, false)).toBe(false);
  expect(second.answer(ok(`${ORIGIN}/`), address)).toBe(false);
  expect(second.answer(ok(address), address)).toBe(true);
  expect(second.answer(ok(address), address)).toBe(false);
  // That load is forgotten when the frame gets a new address before the answer comes.
  const third = tracker();
  expect(third.unreadable(address, false)).toBe(false);
  expect(third.answer(ok(`${ORIGIN}/next`), `${ORIGIN}/next`)).toBe(false);
  expect(third.unreadable(`${ORIGIN}/next`, false)).toBe(true);
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
