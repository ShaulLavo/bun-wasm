import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { armIphoneClick } from "./iphone-browser";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneResponse } from "./iphone-server";
import { createIphoneTransport } from "./iphone-transport";
import type { Transport } from "./transport";

/** `document` holds the preview navigation itself; `resource` holds a load-blocking image after the observer attached. */
type Hold = "document" | "resource";
type Fixture = { page: Page; bus: IphoneBus; transport: Transport; preview: string; requested: Promise<void>; presented: Promise<void>; release(): void; controllerRequests(): number; deviceCommands(): unknown[] };

// Shaped like the executor's terminal read: an owner-page promise that settles on a later task.
const diagnostic = 'new Promise(resolve => setTimeout(() => resolve(document.querySelector("#editor").id), 0))';
const arm = `(${armIphoneClick.toString()})("button", "button")`;
const armedType = (page: Page): Promise<string> => page.frameLocator("iframe").locator("button").evaluate(() => typeof Reflect.get(globalThis, "__goalsIphoneClick"));
const frameActive = (page: Page) => page.waitForFunction(() => document.activeElement?.id === "__goalsIphonePreview", undefined, { timeout: 2000 });

async function withHeldPreview(engine: BrowserType, hold: Hold, timeoutMs: number, action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const bus = new IphoneBus("/__goals_iphone/" + "c".repeat(64));
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const presented = Promise.withResolvers<void>();
  const native: Record<string, unknown>[] = [];
  let ownerOrigin = "";
  let controlOrigin = "";
  let controllerRequests = 0;
  const close: Array<() => void | Promise<void>> = [() => bus.close()];
  const html = (body: string, request: Request) => observeIphoneResponse(new Response(`<!doctype html><body>${body}</body>`, { headers: { "content-type": "text/html" } }), request, bus, controlOrigin);
  const held = async () => { requested.resolve(); await release.promise; };
  const serveOwner = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/held.png") { await held(); return new Response(null, { status: 404 }); }
    if (path !== "/preview") return html('<input id="editor">', request);
    if (hold === "document") await held();
    return html(hold === "resource" ? '<button>Count 0</button><img src="/held.png">' : "<button>Count 0</button>", request);
  };
  try {
    const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
      // Only the page observer sends an Origin; the rest is controller traffic.
      if (!request.headers.has("origin")) controllerRequests++;
      // The controller reads preview state only once its presentation command has returned.
      if (request.method === "GET" && request.url.endsWith("/preview/state")) presented.resolve();
      return bus.handle(request, ownerOrigin);
    } });
    close.push(() => control.stop(true));
    controlOrigin = control.url.origin;
    const owner = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: serveOwner });
    close.push(() => owner.stop(true));
    ownerOrigin = owner.url.origin;
    const browser = await engine.launch({ headless: true });
    close.push(() => browser.close());
    bus.configure("host", owner.url.href);
    const page = await browser.newPage();
    // Native iPhone Safari reports false here with the frame focused; it must never become a readiness predicate.
    await page.addInitScript(() => { Document.prototype.hasFocus = () => false; });
    await page.goto(owner.url.href);
    await page.waitForFunction(() => document.title.startsWith("Goals "));
    await page.locator("#editor").focus();
    const transport = await createIphoneTransport({ control: control.url.origin + bus.path, agent: "/unused/agent-device", deviceUDID: "load-test", timeoutMs,
      saveNative: async text => { native.push(JSON.parse(text)); } });
    close.push(() => transport.close());
    // Every attempted agent-device invocation is recorded with its command, whether or not it could run.
    const deviceCommands = () => native.filter(row => "command" in row);
    await action({ page, bus, transport, deviceCommands, preview: owner.url.origin + "/preview", requested: requested.promise, presented: presented.promise, release: () => release.resolve(), controllerRequests: () => controllerRequests });
  } finally {
    release.resolve();
    await Promise.allSettled(close.toReversed().map(async finish => finish()));
  }
}

async function diagnosticsWhileHeld(engine: BrowserType, hold: Hold): Promise<void> {
  await withHeldPreview(engine, hold, 5000, async ({ page, bus, transport, preview, requested, presented, deviceCommands, release }) => {
    let outcome = "pending";
    const opening = transport.openPreview(preview).then(() => { outcome = "presented"; }, (error: unknown) => { outcome = String(error); });
    await requested;
    // Allow the presentation command to return. If it never does, the reads below report the owner as busy.
    await Promise.race([presented, Bun.sleep(1000)]);
    for (let read = 0; read < 5; read++) {
      await transport.useHost();
      expect(await transport.evaluate<string>(diagnostic)).toBe("editor");
    }
    expect(outcome).toBe("pending");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editor");
    if (hold === "document") expect(bus.state("preview")).toEqual({ url: preview, nonce: expect.any(String), visible: false });
    else expect(await armedType(page)).toBe("undefined");
    release();
    await opening;
    expect(outcome).toBe("presented");
    await frameActive(page);
    expect(await transport.evaluate(arm)).toMatchObject({ ready: true, before: "Count 0" });
    expect(await transport.evaluate("document.hasFocus()")).toBe(false);
    expect(deviceCommands()).toEqual([]);
    await transport.closePreview();
    expect(await page.locator("iframe").count()).toBe(0);
  });
}

async function expiredLoadRefusesInput(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "document", 1000, async ({ page, transport, preview, deviceCommands, release }) => {
    const failure = await transport.openPreview(preview).then(() => "presented", (error: unknown) => String(error));
    expect(failure).not.toBe("presented");
    await transport.useHost();
    expect(await transport.evaluate<string>(diagnostic)).toBe("editor");
    expect(failure).toContain("iPhone preview document did not finish within 1000 ms");
    expect(failure).toContain('"visible":false');
    expect(failure).not.toContain("timeOrigin");
    release();
    // The late load still focuses the frame it belongs to, but the expired opening never arms or presses.
    await frameActive(page);
    await expect(transport.nativeClick!("button", "button", 500)).rejects.toThrow("not focused after load");
    expect(await armedType(page)).toBe("undefined");
    expect(deviceCommands()).toEqual([]);
  });
}

async function closingCancelsHeldLoad(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "resource", 5000, async ({ page, transport, preview, requested, deviceCommands, release, controllerRequests }) => {
    const opening = transport.openPreview(preview).then(() => "presented", (error: unknown) => String(error));
    await requested;
    await transport.close();
    expect(await opening).toContain("iPhone transport closing");
    const settled = controllerRequests();
    release();
    await frameActive(page);
    await Bun.sleep(250);
    expect(controllerRequests()).toBe(settled);
    await expect(transport.nativeClick!("button", "button", 500)).rejects.toThrow();
    expect(controllerRequests()).toBe(settled);
    expect(await armedType(page)).toBe("undefined");
    expect(deviceCommands()).toEqual([]);
  });
}

for (const engine of [chromium, webkit]) {
  for (const hold of ["document", "resource"] satisfies Hold[]) {
    test(`owner diagnostics stay available while the preview ${hold} never finishes loading in ${engine.name()}`, () => diagnosticsWhileHeld(engine, hold), 20000);
  }
  test(`an expired preview load frees the owner channel and refuses late native input in ${engine.name()}`, () => expiredLoadRefusesInput(engine), 20000);
  test(`closing the transport cancels a held preview load without later control traffic or input in ${engine.name()}`, () => closingCancelsHeldLoad(engine), 20000);
}
