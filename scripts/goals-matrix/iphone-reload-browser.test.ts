import { expect, test } from "bun:test";
import { chromium, webkit, type Browser, type BrowserType, type Frame, type Page } from "playwright";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneResponse } from "./iphone-server";
import { presentIphonePreview } from "./iphone-browser";

async function ready(bus: IphoneBus, role: "host" | "preview"): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!bus.state(role)?.timeOrigin) {
    if (Date.now() >= deadline) throw new Error("Observer did not attach");
    await Bun.sleep(10);
  }
}

type Scenario = "rapid" | "fetch" | "fetch-clock" | "identity";

async function reviewControl(engine: BrowserType, scenario: Scenario): Promise<void> {
  const bus = new IphoneBus("/test");
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let navigation = 0;
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/test/preview/poll" && navigation === 2) {
      await holdCurrentPoll(request, bus.state("preview")?.nonce, held.resolve, release.promise);
    }
    return bus.handle(request, owner.url.origin);
  } });
  const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const preview = new URL(request.url).pathname === "/preview";
    if (preview && request.headers.get("sec-fetch-mode") === "navigate") navigation++;
    const html = `<!doctype html><html><body><h1>revision ${navigation}</h1></body></html>`;
    const response = await observeIphoneResponse(new Response(html, { headers: { "content-type": "text/html" } }), request, bus, control.url.origin);
    if (preview && navigation === 3) release.resolve();
    return response;
  } });
  let browser: Browser | undefined;
  try {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    bus.configure("host", owner.url.href);
    await page.goto(owner.url.href);
    await ready(bus, "host");
    const preview = owner.url.origin + "/preview";
    bus.configure("preview", preview);
    await bus.execute("host", `(${presentIphonePreview.toString()})(${JSON.stringify(preview)})`, 3000, false, Date.now() + 3000);
    await ready(bus, "preview");
    if (scenario === "rapid") await rapidReload(bus, page, held.promise);
    else if (scenario === "identity") await identityControls(page);
    else await htmlFetch(bus, page, scenario === "fetch-clock");
  } finally {
    release.resolve(); bus.close(); await browser?.close(); await owner.stop(true); await control.stop(true);
  }
}

async function rapidReload(bus: IphoneBus, page: Page, held: Promise<void>): Promise<void> {
  const read = "new Promise(resolve => { if (document.querySelector('h1').textContent === 'revision 3') resolve('current'); })";
  const pending = bus.execute("preview", read, 3000, true, Date.now() + 3000).catch((error: unknown) => error);
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.location.reload());
  await held;
  await page.evaluate(() => document.querySelector("iframe")!.contentWindow!.location.reload());
  expect(await pending).toBe("current");
}

async function holdCurrentPoll(request: Request, nonce: string | undefined, held: () => void, release: Promise<void>): Promise<void> {
  const row: unknown = await request.clone().json();
  if (!row || typeof row !== "object" || !("nonce" in row) || row.nonce !== nonce) return;
  held();
  await release;
}

async function previewFrame(page: Page): Promise<Frame> {
  const element = await page.locator("#__goalsIphonePreview").elementHandle({ timeout: 3000 });
  try {
    const iframe = await element?.contentFrame();
    if (!iframe) throw new Error("Missing preview frame");
    await iframe.waitForURL(url => url.href.endsWith("/preview"), { timeout: 3000 });
    return iframe;
  } finally {
    await element?.dispose();
  }
}

async function capturePreviewIdentity(frame: Frame) {
  return frame.evaluateHandle(() => {
    const observer = globalThis.__goalsIphoneDocument;
    if (!observer) throw new Error("Missing preview observer");
    return { document, observer };
  });
}

type PreviewIdentity = Awaited<ReturnType<typeof capturePreviewIdentity>>;

function matchesPreviewIdentity(identity: PreviewIdentity): Promise<boolean> {
  return identity.evaluate(anchor => anchor.document === document && anchor.observer === globalThis.__goalsIphoneDocument);
}

async function htmlFetch(bus: IphoneBus, page: Page, varyClock = false): Promise<void> {
  const before = bus.state("preview");
  const iframe = await previewFrame(page);
  const identity = await capturePreviewIdentity(iframe);
  try {
    expect(await iframe.evaluate(async () => (await fetch(location.href)).status)).toBe(200);
    if (varyClock) await iframe.evaluate(() => Object.defineProperty(performance, "timeOrigin", { value: performance.timeOrigin + 1 }));
    expect(await matchesPreviewIdentity(identity)).toBe(true);
    expect(bus.state("preview")?.nonce).toBe(before?.nonce);
    expect(await bus.execute("preview", "document.querySelector('h1').textContent", 1000, true, Date.now() + 1000)).toBe("revision 1");
  } finally {
    await identity.dispose();
  }
}

async function identityControls(page: Page): Promise<void> {
  const iframe = await previewFrame(page);
  const url = iframe.url();
  const identity = await capturePreviewIdentity(iframe);
  try {
    expect(await matchesPreviewIdentity(identity)).toBe(true);
    await identity.evaluate(anchor => { globalThis.__goalsIphoneDocument = { ...anchor.observer }; });
    expect(await matchesPreviewIdentity(identity)).toBe(false);
    await identity.evaluate(anchor => { globalThis.__goalsIphoneDocument = anchor.observer; });
    expect(await matchesPreviewIdentity(identity)).toBe(true);
    await iframe.goto(url, { timeout: 3000 });
    expect(iframe.url()).toBe(url);
    await expect(matchesPreviewIdentity(identity)).rejects.toThrow();
  } finally {
    await identity.dispose();
  }
  const replacement = await capturePreviewIdentity(iframe);
  try {
    await page.evaluate(presentIphonePreview, url);
    await expect(matchesPreviewIdentity(replacement)).rejects.toThrow();
  } finally {
    await replacement.dispose();
  }
}

async function heldPreviewNavigation(engine: BrowserType): Promise<void> {
  const release = Promise.withResolvers<void>();
  const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/preview") await release.promise;
    return new Response("<!doctype html><html><body>preview</body></html>", { headers: { "content-type": "text/html" } });
  } });
  let browser: Browser | undefined;
  try {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(owner.url.href);
    const url = owner.url.origin + "/preview";
    const requested = page.waitForRequest(url, { timeout: 3000 });
    await page.evaluate(presentIphonePreview, url);
    await requested;
    expect(page.frames().some(frame => frame.url() === url)).toBe(false);
    const pending = previewFrame(page);
    await Promise.all([
      pending.then(frame => expect(frame.url()).toBe(url)),
      page.evaluate(() => document.querySelector("iframe")?.isConnected).then(attached => {
        expect(attached).toBe(true);
        release.resolve();
      }),
    ]);
  } finally {
    release.resolve(); await browser?.close(); await owner.stop(true);
  }
}

for (const engine of [chromium, webkit]) {
  test(`preview frame waits for held navigation in ${engine.name()}`, () => heldPreviewNavigation(engine), 15000);
  test(`document identity rejects observer replacement, same-URL navigation and iframe replacement in ${engine.name()}`, () => reviewControl(engine, "identity"), 15000);
  test(`non-navigation fetch preserves document identity with a changed clock read in ${engine.name()}`, () => reviewControl(engine, "fetch-clock"), 15000);
  test(`rapid preview reloads reject the superseded attaching document in ${engine.name()}`, () => reviewControl(engine, "rapid"), 15000);
  test(`non-navigation preview HTML fetch preserves the observer in ${engine.name()}`, () => reviewControl(engine, "fetch"), 15000);
}
