import { expect, test } from "bun:test";
import { FrameWatcher } from "../src/preview-origin/frame-watch";
import type { FrameMessage } from "../src/preview-origin/protocol";

const ORIGIN = `https://${"a".repeat(52)}-5173-pv.sprockt.dev`;
const OTHER_PORT = `https://${"a".repeat(52)}-3000-pv.sprockt.dev`;
const ok = (url: string) => ({ url, status: 200, location: null });
const redirect = (url: string, location: string, status = 302) => ({ url, status, location });
const report = (event: FrameMessage["event"], href: string, transient = false): FrameMessage => ({ type: "bunwasm-preview-frame", event, href, transient });

/** A watched frame: the test assigns its address and plays its `load` events and the servers' answers. */
function watched(options: { runsServer?: boolean } = {}) {
  const events: string[] = [];
  const frame = { src: null as string | null };
  const watcher = new FrameWatcher({
    address: () => frame.src,
    isPreview: url => url.startsWith(ORIGIN) || url.startsWith(OTHER_PORT),
    runsServer: () => options.runsServer ?? true,
  }, {
    loaded: (href) => { events.push(`loaded ${href}`); },
    failed: (transient) => { events.push(transient ? "failed, try again" : "failed"); },
  });
  return { events, frame, watcher };
}

test("the initial blank document of a frame without an address settles nothing", () => {
  for (const runsServer of [true, false]) {
    const { events, frame, watcher } = watched({ runsServer });
    // Chromium fires `load` for about:blank when the frame is inserted, before it has an address.
    watcher.frameLoaded();
    watcher.frameLoaded();
    watcher.answered(ok(`${ORIGIN}/notes.txt`));
    watcher.frameLoaded();
    expect(events).toEqual([]);
    frame.src = `${ORIGIN}/notes.txt`;
    watcher.answered(ok(`${ORIGIN}/notes.txt`));
    watcher.frameLoaded();
    expect(events).toEqual(["loaded null"]);
  }
});

test("only the final response to the frame's own address makes its load event count", () => {
  const { events, frame, watcher } = watched();
  frame.src = `${ORIGIN}/notes.txt`;
  // The cold-load page, or an error page whose report is still on its way.
  watcher.frameLoaded();
  // Another frame's document, a frame of the app itself, another port's page: none is this frame's navigation.
  watcher.answered(ok(`${ORIGIN}/`));
  watcher.answered(ok(`${ORIGIN}/notes.txt?download=1`));
  watcher.answered(ok(`${OTHER_PORT}/notes.txt`));
  watcher.answered(ok(`${ORIGIN}/embedded/frame.html`));
  watcher.frameLoaded();
  expect(events).toEqual([]);
  // A fragment is the document's own business.
  watcher.answered(ok(`${ORIGIN}/notes.txt#section`));
  watcher.frameLoaded();
  expect(events).toEqual(["loaded null"]);
  // One answer settles one load.
  watcher.frameLoaded();
  expect(events).toEqual(["loaded null"]);
});

test("a redirect is not a document: the frame settles with the final response of the chain", () => {
  const { events, frame, watcher } = watched();
  frame.src = `${ORIGIN}/old`;
  watcher.answered(redirect(`${ORIGIN}/old`, "/login?next=%2Fold"));
  // The load of an error page for the redirect target must not count.
  watcher.frameLoaded();
  expect(events).toEqual([]);
  // The frame's first address is no longer what is awaited.
  watcher.answered(ok(`${ORIGIN}/old`));
  watcher.frameLoaded();
  expect(events).toEqual([]);
  watcher.answered(redirect(`${ORIGIN}/login?next=%2Fold`, `${OTHER_PORT}/sso#token`, 307));
  watcher.frameLoaded();
  expect(events).toEqual([]);
  watcher.answered(ok(`${OTHER_PORT}/sso`));
  watcher.frameLoaded();
  expect(events).toEqual(["loaded null"]);
  // 300 and 304, or a redirect status without Location, are final responses.
  for (const answer of [{ url: `${ORIGIN}/old`, status: 304, location: null }, { url: `${ORIGIN}/old`, status: 302, location: null }, { url: `${ORIGIN}/old`, status: 300, location: "/x" }]) {
    watcher.answered(answer);
    watcher.frameLoaded();
  }
  expect(events).toEqual(["loaded null", "loaded null", "loaded null", "loaded null"]);
});

test("a redirect off the preview origins ends the wait at the next load, since nothing more can be heard", () => {
  const { events, frame, watcher } = watched();
  frame.src = `${ORIGIN}/out`;
  watcher.answered(redirect(`${ORIGIN}/out`, "https://example.com/landing"));
  expect(events).toEqual([]);
  watcher.frameLoaded();
  expect(events).toEqual(["loaded null"]);
});

test("the page's own reports settle the frame and start the next wait afresh", () => {
  const { events, frame, watcher } = watched();
  frame.src = `${ORIGIN}/`;
  watcher.reported(report("commit", `${ORIGIN}/`));
  expect(events).toEqual([]);
  // The service worker answered for the server: a load event that follows is the error page's own.
  watcher.answered(ok(`${ORIGIN}/`));
  watcher.reported(report("error", `${ORIGIN}/`, true));
  watcher.frameLoaded();
  expect(events).toEqual(["failed, try again"]);
  // The retry reaches the server, and a page with the shim also says where it is.
  watcher.answered(ok(`${ORIGIN}/`));
  watcher.reported(report("load", `${ORIGIN}/`));
  watcher.frameLoaded();
  expect(events).toEqual(["failed, try again", `loaded ${ORIGIN}/`]);
  watcher.reported(report("error", `${ORIGIN}/`));
  expect(events.at(-1)).toBe("failed");
});

test("a tab that only shows another tab's server settles when both the answer and the load have come, in either order", () => {
  const first = watched({ runsServer: false });
  first.frame.src = `${ORIGIN}/notes.txt`;
  first.watcher.answered(ok(`${ORIGIN}/notes.txt`));
  expect(first.events).toEqual([]);
  first.watcher.frameLoaded();
  expect(first.events).toEqual(["loaded null"]);
  // The other tab's word travels on its own channel and may arrive after the document did.
  const second = watched({ runsServer: false });
  second.frame.src = `${ORIGIN}/notes.txt`;
  second.watcher.frameLoaded();
  second.watcher.answered(ok(`${ORIGIN}/`));
  expect(second.events).toEqual([]);
  second.watcher.answered(ok(`${ORIGIN}/notes.txt`));
  expect(second.events).toEqual(["loaded null"]);
  // The tab that runs the server hears each answer before the document can load, so there the order is strict.
  const owner = watched({ runsServer: true });
  owner.frame.src = `${ORIGIN}/notes.txt`;
  owner.watcher.frameLoaded();
  owner.watcher.answered(ok(`${ORIGIN}/notes.txt`));
  expect(owner.events).toEqual([]);
  owner.watcher.frameLoaded();
  expect(owner.events).toEqual(["loaded null"]);
});
