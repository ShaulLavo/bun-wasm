import type { BrowserType, Page } from "playwright";
import { IphoneBus } from "./iphone-bus";
import { observeIphoneResponse } from "./iphone-server";
import { createIphoneTransport } from "./iphone-transport";
import type { Transport } from "./transport";

/** `document` holds the preview navigation itself; `resource` holds a load-blocking image after the observer attached. */
export type Hold = "document" | "resource";
export type HeldPreview = {
  page: Page; bus: IphoneBus; transport: Transport; preview: string;
  /** Resolves when the held request reaches the server. */
  requested: Promise<void>;
  /** Resolves when the controller first reads preview state, which follows its presentation command. */
  presented: Promise<void>;
  release(): void;
  controllerRequests(): number;
  deviceCommands(): unknown[];
};

/**
 * A real owner page with a focused editor and the real bus, observer and transport. The preview
 * has an enabled counter and stays loading until `release`. No native device exists: every
 * attempted agent-device invocation is recorded and fails.
 */
export async function withHeldPreview(engine: BrowserType, hold: Hold, timeoutMs: number, action: (fixture: HeldPreview) => Promise<void>): Promise<void> {
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
    const deviceCommands = () => native.filter(row => "command" in row);
    await action({ page, bus, transport, deviceCommands, preview: owner.url.origin + "/preview", requested: requested.promise, presented: presented.promise, release: () => release.resolve(), controllerRequests: () => controllerRequests });
  } finally {
    release.resolve();
    await Promise.allSettled(close.toReversed().map(async finish => finish()));
  }
}
