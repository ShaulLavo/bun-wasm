import { withScoped, withAdmission } from "./scope-fixture";
import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { armIphoneClick } from "./iphone-browser";
import { withHeldPreview, type HeldPreview, type Hold } from "./iphone-load-fixture";
import { execute } from "./execute";
import { frameworks, type Framework } from "./catalog";
import { withPlayground } from "./test-fixture";
import type { Admission } from "./scope";
import { scoped, type Transport } from "./transport";
import { render } from "./playground";

// Shaped like the executor's terminal read: an owner-page promise that settles on a later task.
const diagnostic = 'new Promise(resolve => setTimeout(() => resolve(document.querySelector("#editor").id), 0))';
const arm = `(${armIphoneClick.toString()})("button", "button")`;
const armedType = (page: Page): Promise<string> => page.frameLocator("iframe").locator("button").evaluate(() => typeof Reflect.get(globalThis, "__goalsIphoneClick"));
const frameActive = (page: Page) => page.waitForFunction(() => document.activeElement?.id === "__goalsIphonePreview", undefined, { timeout: 2000 });

async function diagnosticsWhileHeld(engine: BrowserType, hold: Hold): Promise<void> {
  await withHeldPreview(engine, hold, 5000, async ({ page, bus, transport, preview, requested, presented, deviceCommands, release, evidence, observed }) => {
    let outcome = "pending";
    const opening = withScoped(transport, page => page.openPreview(preview)).then(() => { outcome = "presented"; }, (error: unknown) => { outcome = String(error); });
    await requested;
    // Allow the presentation command to return. If it never does, the reads below report the owner as busy.
    await Promise.race([presented, Bun.sleep(1000)]);
    for (let read = 0; read < 5; read++) {
      await withScoped(transport, page => page.useHost());
      expect(await withScoped(transport, page => page.evaluate<string>(diagnostic))).toBe("editor");
    }
    expect(outcome).toBe("pending");
    const stage = hold === "document" ? "document" : "load";
    await observed(stage);
    expect(evidence().at(-1)).toMatchObject({ event: "iphone-preview", stage, observation: hold === "document" ? { attached: false } : { loaded: false } });
    expect(evidence().some(row => row.stage === "open-preview-complete")).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editor");
    if (hold === "document") expect(bus.state("preview")).toEqual({ url: preview, nonce: expect.any(String), visible: false });
    else expect(await armedType(page)).toBe("undefined");
    release();
    await opening;
    expect(outcome).toBe("presented");
    expect(evidence().at(-1)).toMatchObject({ stage: "open-preview-complete", outcome: "returned" });
    await frameActive(page);
    expect(await withScoped(transport, page => page.evaluate(arm))).toMatchObject({ ready: true, before: "Count 0" });
    expect(await withScoped(transport, page => page.evaluate("document.hasFocus()"))).toBe(false);
    expect(deviceCommands()).toEqual([]);
    await withScoped(transport, page => page.closePreview());
    expect(await page.locator("iframe").count()).toBe(0);
  });
}

async function expiredLoadRefusesInput(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "document", 1000, async ({ page, transport, preview, deviceCommands, release }) => {
    const failure = await withScoped(transport, page => page.openPreview(preview)).then(() => "presented", (error: unknown) => String(error));
    expect(failure).not.toBe("presented");
    await withScoped(transport, page => page.useHost());
    expect(await withScoped(transport, page => page.evaluate<string>(diagnostic))).toBe("editor");
    expect(failure).toContain("iPhone preview document did not finish within 1000 ms");
    expect(failure).toContain('"visible":false');
    expect(failure).not.toContain("timeOrigin");
    release();
    // The late load still focuses the frame it belongs to, but the expired opening never arms or presses.
    await frameActive(page);
    await expect(withScoped(transport, page => page.nativeClick!("button", "button", 500))).rejects.toThrow("not focused after load");
    expect(await armedType(page)).toBe("undefined");
    expect(deviceCommands()).toEqual([]);
  });
}

async function closingCancelsHeldLoad(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "resource", 5000, async ({ page, transport, preview, requested, deviceCommands, release, controllerRequests, evidence, observed }) => {
    const opening = withScoped(transport, page => page.openPreview(preview)).then(() => "presented", (error: unknown) => String(error));
    await requested;
    await observed("load");
    await transport.close();
    expect(await opening).toContain("iPhone transport closing");
    expect(evidence().at(-1)).toMatchObject({ stage: "load", outcome: "cancelled", observation: { loaded: false } });
    const settled = controllerRequests();
    const saved = evidence().length;
    release();
    await frameActive(page);
    await Bun.sleep(250);
    expect(controllerRequests()).toBe(settled);
    expect(evidence()).toHaveLength(saved);
    await expect(withScoped(transport, page => page.nativeClick!("button", "button", 500))).rejects.toThrow();
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
  for (const scenario of ["held-timeout", "focus-cancel"] as const) {
    test(`executor ${scenario} preserves current owner diagnostics in ${engine.name()}`, () => executionFailure(engine, scenario), 15000);
  }
  for (const command of ["presentIphonePreview", "iphonePreviewLoad", "rendered"] as const) {
    test(`undelivered ${command} retains its exact stage in ${engine.name()}`, () => undeliveredCommand(engine, command), 30000);
  }
}

async function undeliveredCommand(engine: BrowserType, command: "presentIphonePreview" | "iphonePreviewLoad" | "rendered"): Promise<void> {
  await withHeldPreview(engine, "document", 30000, async ({ bus, transport, preview, release, evidence, deviceCommands }) => {
    let blocked: "host" | "preview" | undefined;
    const poll = bus.poll.bind(bus);
    bus.poll = (role, value, origin) => role === blocked ? null : poll(role, value, origin);
    const original = bus.execute.bind(bus);
    const stop = new AbortController();
    bus.execute = (role, source, timeoutMs, observation, deliverByMs) => {
      const pending = original(role, source, timeoutMs, observation, deliverByMs);
      if (!source.startsWith(`(function ${command}(`)) return pending;
      blocked = role;
      // Cancel the outer phase only after the real bus has registered the undelivered command.
      stop.abort(new Error("Fixture cancelled undelivered command"));
      return pending;
    };
    release();
    const framework = frameworks.find(row => row.id === "next");
    if (!framework) throw new Error("Missing Next fixture");
    const action = withAdmission(async admission => {
      const page = scoped(transport, { ...admission, signal: stop.signal });
      await page.openPreview(preview);
      if (command === "rendered") await render(page, framework, framework.text, 30000);
    });
    await expect(action).rejects.toThrow("Fixture cancelled undelivered command");
    const stage = command === "presentIphonePreview" ? "presentation" : "load";
    if (command !== "rendered") expect(evidence().at(-1)).toMatchObject({ stage });
    else expect(evidence().at(-1)).toMatchObject({ event: "iphone-rendered", first: { dispatched: true, delivered: "unknown", settled: false } });
    await transport.close();
    expect(deviceCommands()).toEqual([]);
  });
}

async function executionFailure(engine: BrowserType, scenario: "held-timeout" | "focus-cancel"): Promise<void> {
  const framework = frameworks.find(row => row.id === "sveltekit");
  if (!framework) throw new Error("Missing SvelteKit fixture");
  await withPlayground(framework, 0, fixture => withHeldPreview(engine, "document", 5000, held => runFailureFixture(framework, fixture, held, scenario)));
}

async function runFailureFixture(framework: Framework, fixture: Transport, held: HeldPreview, scenario: "held-timeout" | "focus-cancel"): Promise<void> {
  const { page, bus, transport, preview, requested, release, deviceCommands } = held;
  const abort = new AbortController();
  const logs: string[] = [];
  let failed = false;
  await page.evaluate('globalThis.playground = { term: { write: (_text, done) => setTimeout(done, 0), buffer: { active: { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => "Error: current dev diagnostic" }) } } } };');
  const state = bus.state.bind(bus);
  bus.state = role => {
    const value = state(role);
    if (scenario === "focus-cancel" && role === "host" && value?.previewFocus?.focused) abort.abort(new Error("Phase cancelled at focus acknowledgement"));
    return value;
  };
  const original = bus.execute.bind(bus);
  bus.execute = (role, source, timeoutMs, observation, deliverByMs) => {
    const pending = original(role, source, timeoutMs, observation, deliverByMs);
    if (scenario === "focus-cancel" && source.includes("function iphonePreviewFocus")) abort.abort(new Error("Phase cancelled at focus acknowledgement"));
    return pending;
  };
  const facade: Transport = { ...transport, navigate: fixture.navigate,
    evaluate: <T>(source: string, admission: Admission, options?: Parameters<Transport["evaluate"]>[2]) => {
      if (failed) return transport.evaluate<T>(source, admission, options);
      return fixture.evaluate<T>(source.includes("function transcript") ? JSON.stringify("completed install transcript") : source, admission, options);
    },
    async openPreview(_url, admission) {
      failed = true;
      const opening = transport.openPreview(preview, admission);
      await requested;
      if (scenario === "focus-cancel") release();
      await opening;
    },
  };
  const result = await execute({ framework, box: { framework: framework.id, browser: "iphone-safari", engine: "browser" },
    url: "http://fixture/?engine=browser", timeoutMs: scenario === "held-timeout" ? 1000 : 5000, signal: abort.signal,
    createTransport: async () => facade, saveLog: async text => { logs.push(text); },
  });
  expect(result).toMatchObject({ status: "fail", phase: "render" });
  expect(logs.join("\n")).toContain("Error: current dev diagnostic");
  expect(deviceCommands()).toEqual([]);
  const final = held.evidence().filter(row => row.event === "iphone-preview").at(-1);
  expect(final).toMatchObject({ stage: scenario === "held-timeout" ? "document" : "focus" });
  if (scenario === "held-timeout") expect(final?.outcome === "failed" || final?.outcome === "cancelled").toBe(true);
  else expect(final?.outcome).toBe("cancelled");
}
