import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { withHeldPreview, type HeldPreview } from "./iphone-load-fixture";
import { withPlayground } from "./test-fixture";
import { execute } from "./execute";
import { frameworks, type Framework } from "./catalog";
import { createPageTransport, type Transport } from "./transport";
import { Scope } from "./scope";

type Scenario = "normal" | "undelivered" | "stalled" | "late";
type Event = { event: "enqueue" | "settled" | "rejected"; operation: string; at: number };
const transcript = "Current owner terminal is immediately available";

async function run(engine: BrowserType, scenario: Scenario): Promise<void> {
  const framework = frameworks.find(row => row.id === "sveltekit");
  if (!framework) throw new Error("Missing SvelteKit fixture");
  await withPlayground(framework, 0, fixture => withHeldPreview(engine, "document", 7000, held => lifecycle(framework, fixture, held, scenario)));
}

async function lifecycle(framework: Framework, fixture: Transport, held: HeldPreview, scenario: Scenario): Promise<void> {
  const { page, bus, transport } = held;
  const abort = new AbortController();
  const events: Event[] = [];
  const settled = Promise.withResolvers<unknown>();
  const logs: string[] = [];
  let cancelledAt = 0, cleanup = false, heldId: number | undefined;
  const state = { shells: 0, rejected: 0, deliverByMs: 0 };
  await page.evaluate(({ text, unfinished }) => {
    Object.assign(globalThis, { fixtureSubmits: 0, playground: {
      shell: { lastExit: 0, async submit() {
        Reflect.set(globalThis, "fixtureSubmits", Reflect.get(globalThis, "fixtureSubmits") + 1);
        if (unfinished) await new Promise(() => {});
      } },
      term: { write(_text: string, done: () => void) { done(); }, buffer: { active: { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => text }) } } },
    } });
  }, { text: transcript, unfinished: scenario === "undelivered" });
  const poll = bus.poll.bind(bus);
  bus.poll = (role, value, origin) => {
    if (scenario === "undelivered" && role === "host" && heldId !== undefined) return null;
    return poll(role, value, origin);
  };
  const original = bus.execute.bind(bus);
  bus.execute = (role, source, timeoutMs, observation, deliverByMs) => {
    const operation = source.includes("function shellState") ? "shellState" : source.includes("function transcript") ? "transcript" : "launch";
    const hold = scenario === "undelivered" && operation === "shellState" && deliverByMs - Date.now() < 100;
    const replacement = operation === "shellState" && scenario === "stalled" ? "new Promise(() => {})"
      : operation === "shellState" && scenario === "late" ? "new Promise(resolve => setTimeout(() => resolve({ done: true, code: 0, error: null }), 2500))" : source;
    events.push({ event: "enqueue", operation, at: performance.now() });
    let pending: Promise<unknown>;
    try { pending = original(role, replacement, timeoutMs, observation, deliverByMs); }
    catch (error) { state.rejected++; throw error; }
    if (hold) { heldId = 1; state.deliverByMs = deliverByMs; }
    const tracked = pending.then(value => {
      if (hold) heldId = undefined;
      events.push({ event: "settled", operation, at: performance.now() });
      return value;
    }, error => {
      if (hold) heldId = undefined;
      events.push({ event: "rejected", operation, at: performance.now() });
      throw error;
    });
    if (operation !== "shellState") return tracked;
    state.shells++;
    if (scenario !== "undelivered" && state.shells === 1) {
      cancelledAt = performance.now();
      abort.abort(new Error("Fixture phase cancelled at normal shellState enqueue"));
      void tracked.then(settled.resolve, settled.resolve);
    }
    return tracked;
  };
  const facade: Transport = { ...transport, navigate: fixture.navigate,
    evaluate: (source, admission, options) => source.includes("function readyState") ? fixture.evaluate(source, admission, options) : transport.evaluate(source, admission, options),
    async cleanup(timeoutMs) { cleanup = true; return transport.cleanup!(timeoutMs); },
  };
  const result = await execute({ framework, box: { framework: framework.id, browser: "iphone-safari", engine: "browser" },
    url: "http://fixture/?engine=browser", timeoutMs: 7000, installTimeoutMs: scenario === "undelivered" ? 400 : 7000, signal: abort.signal,
    createTransport: async () => facade, saveLog: async text => { logs.push(text); },
  });
  const returnedAt = performance.now();
  expect(result).toMatchObject({ status: "fail", phase: "install" });
  const install = result.attempts[0]?.phases.find(row => row.phase === "install");
  expect(install).toMatchObject({ status: "fail", timeoutMs: scenario === "undelivered" ? 400 : 7000,
    error: scenario === "undelivered" ? "Error: Phase timed out after 400 ms" : "Error: Fixture phase cancelled at normal shellState enqueue" });
  expect(cleanup).toBe(true);
  expect(state.rejected).toBe(0);
  expect(await page.evaluate(() => Reflect.get(globalThis, "fixtureSubmits"))).toBe(1);
  expect(held.deviceCommands()).toEqual([]);
  const terminals = () => events.filter(row => row.event === "enqueue" && row.operation === "transcript");
  if (scenario === "stalled") {
    expect(returnedAt - cancelledAt).toBeGreaterThanOrEqual(3900);
    expect(returnedAt - cancelledAt).toBeLessThan(6500);
    expect(logs.join("\n")).toContain("Final terminal observation unavailable");
    expect(logs.join("\n")).toContain("Failure capture:");
    expect(terminals()).toHaveLength(0);
    await settled.promise;
    expect(terminals()).toHaveLength(0);
    return;
  }
  expect(logs.join("\n")).toContain(transcript);
  if (scenario === "undelivered") {
    expect(state.deliverByMs).toBeGreaterThan(0);
    expect(events.some(row => row.event === "rejected" && row.operation === "shellState")).toBe(true);
    return;
  }
  await settled.promise;
  expect(state.shells).toBe(1);
  expect(terminals()).toHaveLength(scenario === "late" ? 1 : 2);
  const answer = events.find(row => row.event === "settled" && row.operation === "shellState");
  const first = terminals()[0];
  if (!first || !answer) throw new Error("Missing terminal or shell settlement event");
  expect(first.at).toBeGreaterThanOrEqual(answer.at);
  if (scenario === "late") expect(first.at - cancelledAt).toBeGreaterThanOrEqual(2000);
}

async function delayedReceipt(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "document", 3000, async ({ bus, page, transport }) => {
    const scope = Scope.open(400), next = Scope.open(2000);
    const release = Promise.withResolvers<void>();
    const selected = Promise.withResolvers<void>(), replied = Promise.withResolvers<void>();
    const poll = bus.poll.bind(bus), reply = bus.reply.bind(bus);
    let held = false, negatives = 0;
    bus.poll = (role, value, origin) => {
      const task = poll(role, value, origin);
      if (role !== "host" || task === null || held) return task;
      held = true; selected.resolve();
      return release.promise.then(() => task);
    };
    bus.reply = (role, value, origin) => {
      reply(role, value, origin);
      if (value && typeof value === "object" && "ok" in value && value.ok === false) { negatives++; replied.resolve(); }
    };
    try {
      const result = transport.evaluate("globalThis.lateExecutions = (globalThis.lateExecutions ?? 0) + 1", scope);
      void result.catch(() => {});
      await selected.promise;
      await expect(result).rejects.toThrow("Phase timed out");
      release.resolve();
      await replied.promise;
      expect(negatives).toBe(1);
      expect(await page.evaluate(() => Reflect.get(globalThis, "lateExecutions"))).toBeUndefined();
      expect(await transport.evaluate("42", next)).toBe(42);
    } finally { release.resolve(); scope.close(); next.close(); }
  });
}

function heldPageCreation(preview: Page, stage: "close" | "creation", entered: () => void, release: Promise<void>, state: { creations: number }) {
  return { async newPage() {
    state.creations++;
    if (stage !== "creation" && state.creations !== 2) return preview;
    entered();
    await release;
    return preview;
  } };
}

async function prepareExistingPreview(transport: Transport): Promise<void> {
  const scope = Scope.open(3000);
  try { await transport.openPreview("about:blank", scope); }
  finally { scope.close(); }
}

async function latePlaywrightStep(engine: BrowserType, stage: "close" | "creation"): Promise<void> {
  const browser = await engine.launch({ headless: true });
  let scope: Scope | undefined, next: Scope | undefined;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holdClose = async () => { entered.resolve(); await release.promise; };
  try {
    const context = await browser.newContext(), host = await context.newPage(), preview = await context.newPage();
    await host.setContent("<title>owner</title>");
    const state = { creations: 0, navigations: 0 };
    const transport = createPageTransport(heldPageCreation(preview, stage, entered.resolve, release.promise, state), host, {}, 3000, 3000, () => browser.close());
    if (stage === "close") {
      await prepareExistingPreview(transport);
      preview.close = holdClose;
    }
    preview.goto = async () => { state.navigations++; return null; };
    scope = Scope.open(3000);
    next = Scope.open(3000);
    const opening = transport.openPreview("http://unused.invalid/", scope);
    await Promise.race([entered.promise, opening]);
    scope.close(new Error("phase cancelled"));
    await expect(opening).rejects.toThrow("phase cancelled");
    release.resolve();
    // The held operation resumes before this read, which also proves the active page stayed owned.
    expect(await transport.evaluate("document.title", next)).toBe(stage === "close" ? "" : "owner");
    expect(state.creations).toBe(1);
    expect(state.navigations).toBe(0);
    await transport.close();
    expect(context.pages()).toHaveLength(0);
  } finally { release.resolve(); scope?.close(); next?.close(); await browser.close(); }
}

async function cancelledArm(engine: BrowserType): Promise<void> {
  const framework = frameworks[0];
  if (!framework) throw new Error("Missing framework");
  await withPlayground(framework, 0, fixture => withHeldPreview(engine, "document", 3000, async held => {
    const preparation = Scope.open(3000);
    const abort = new AbortController();
    const answer = Promise.withResolvers<void>();
    const original = held.bus.execute.bind(held.bus);
    try {
      held.release();
      await held.transport.openPreview(held.preview, preparation);
      held.bus.execute = (role, source, timeoutMs, observation, deliverByMs) => {
        const result = original(role, source, timeoutMs, observation, deliverByMs);
        if (source.includes("function armIphoneClick")) {
          abort.abort(new Error("click phase cancelled at arm read"));
          void result.then(() => answer.resolve(), () => answer.resolve());
        }
        return result;
      };
      const facade: Transport = { ...fixture, nativeClick: held.transport.nativeClick, cleanup: timeoutMs => held.transport.cleanup!(timeoutMs) };
      const result = await execute({ framework, box: { framework: framework.id, browser: "iphone-safari", engine: "browser" },
        url: "http://fixture/?engine=browser", timeoutMs: 3000, signal: abort.signal,
        createTransport: async () => facade, saveLog: async () => {},
      });
      await answer.promise;
      expect(result).toMatchObject({ status: "fail", phase: "click" });
      expect(held.deviceCommands()).toEqual([]);
    } finally { preparation.close(); }
  }));
}

for (const engine of [chromium, webkit]) {
  for (const scenario of ["normal", "undelivered", "stalled", "late"] satisfies Scenario[]) {
    test(`owner handoff ${scenario} in ${engine.name()}`, () => run(engine, scenario), 15_000);
  }
  test(`page rejects delivery received after its cutoff in ${engine.name()}`, () => delayedReceipt(engine), 10_000);
  test(`cancelled click arm starts no native snapshot or press in ${engine.name()}`, () => cancelledArm(engine), 10_000);
  for (const stage of ["close", "creation"] satisfies Array<"close" | "creation">) {
    test(`Playwright fences late preview ${stage} in ${engine.name()}`, () => latePlaywrightStep(engine, stage), 10_000);
  }
}
