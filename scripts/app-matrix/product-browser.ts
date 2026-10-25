import type { FeatureProbe, ProductCheck, SourceEdit } from "./product-types";

interface Locator {
  filter(options: { hasText: string }): Locator;
  waitFor(options: { timeout: number }): Promise<void>;
  click(options: { timeout: number }): Promise<void>;
}
interface Response {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  headers(): Record<string, string>;
}
export interface ProductPage {
  addInitScript(script: () => void): Promise<void>;
  exposeBinding(name: string, callback: (source: unknown, value: unknown) => void): Promise<void>;
  removeExposedBinding(name: string): Promise<void>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  locator(selector: string): Locator;
  goto(url: string, options: { timeout: number }): Promise<Response | null>;
}
export interface GuestSource {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
}
export interface Observation {
  stage: string;
  status: "pass" | "fail" | "blocked";
  assertion?: string;
  blocker?: string;
}
export interface TrafficEvidence {
  sequence: number;
  framework: "next" | "vite";
  event: string;
  payload: string;
}
export interface ProductTraffic {
  count(): Promise<number>;
  evidenceSince(sequence: number): Promise<readonly TrafficEvidence[]>;
  close(): Promise<void>;
}

const trafficBindingName = "__bunWasmProductTrafficReport";

declare global {
  var __bunWasmProductTraffic: { close(): void } | undefined;
  var __bunWasmProductTrafficReport: ((event: unknown) => unknown) | undefined;
}

function installPreviewTrafficObserver() {
  const existing = globalThis.__bunWasmProductTraffic;
  if (existing) return;

  const nativeWebSocket = globalThis.WebSocket;
  const eventTarget = globalThis.EventTarget;
  const descriptor = Object.getOwnPropertyDescriptor(eventTarget.prototype, "dispatchEvent");
  if (!descriptor || typeof descriptor.value !== "function") return;

  const originalDispatch = descriptor.value;
  const nextActions = new Set([
    "built", "sync", "reloadPage", "serverComponentChanges", "clientChanges",
    "serverOnlyChanges", "middlewareChanges", "addedPage", "removedPage", "turbopack-message",
  ]);
  const nextEvents = new Set(["clientChanges", "serverOnlyChanges", "middlewareChanges"]);
  const viteEvents = new Set(["update", "full-reload"]);

  function textPayload(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    return null;
  }

  function stringProperty(value: object, key: string): string | null {
    const candidate = Reflect.get(value, key);
    return typeof candidate === "string" ? candidate : null;
  }

  function frameworkEvent(target: EventTarget, event: Event): { framework: "next" | "vite"; event: string; payload: string } | null {
    if (event.type !== "message") return null;
    if (typeof globalThis.WebSocket !== "function" || !(target instanceof globalThis.WebSocket)) return null;
    if (typeof nativeWebSocket === "function" && target instanceof nativeWebSocket) return null;
    if (!("data" in event)) return null;
    const payload = textPayload(event.data);
    if (payload === null) return null;

    let message: unknown;
    try { message = JSON.parse(payload); }
    catch { return null; }
    if (!message || typeof message !== "object") return null;

    const type = stringProperty(message, "type");
    if (type && viteEvents.has(type)) return { framework: "vite", event: type, payload };
    const action = stringProperty(message, "action");
    if (action && nextActions.has(action)) return { framework: "next", event: action, payload };
    const eventName = stringProperty(message, "event");
    if (eventName && nextEvents.has(eventName)) return { framework: "next", event: eventName, payload };
    return null;
  }

  const wrappedDispatch = function (this: EventTarget, event: Event): boolean {
    try {
      const observed = frameworkEvent(this, event);
      if (!observed) return Reflect.apply(originalDispatch, this, [event]);
      try { void globalThis.__bunWasmProductTrafficReport?.(observed); }
      catch { }
    } catch { }
    return Reflect.apply(originalDispatch, this, [event]);
  };

  Object.defineProperty(eventTarget.prototype, "dispatchEvent", { ...descriptor, value: wrappedDispatch });
  const state = {
    close() {
      Object.defineProperty(eventTarget.prototype, "dispatchEvent", descriptor);
      delete globalThis.__bunWasmProductTraffic;
    },
  };
  Object.defineProperty(globalThis, "__bunWasmProductTraffic", { configurable: true, value: state });
}

function closePreviewTrafficObserver(): void {
  globalThis.__bunWasmProductTraffic?.close();
}

function isTrafficEvidence(value: unknown): value is Omit<TrafficEvidence, "sequence"> {
  if (!value || typeof value !== "object") return false;
  if (!("framework" in value) || !("event" in value) || !("payload" in value)) return false;
  return (value.framework === "next" || value.framework === "vite")
    && typeof value.event === "string"
    && typeof value.payload === "string";
}

export async function observeProductTraffic(page: ProductPage): Promise<ProductTraffic> {
  const events: TrafficEvidence[] = [];
  let nextSequence = 1;
  const receive = (_source: unknown, value: unknown): void => {
    if (!isTrafficEvidence(value)) return;
    events.push({ sequence: nextSequence++, ...value });
  };
  await page.exposeBinding(trafficBindingName, receive);
  await page.addInitScript(installPreviewTrafficObserver);
  let closed = false;
  return {
    count: async () => events.length,
    evidenceSince: async sequence => events.slice(sequence).map(event => ({ ...event })),
    close: async () => {
      if (closed) return;
      try { await page.evaluate(closePreviewTrafficObserver); }
      finally {
        closed = true;
        await page.removeExposedBinding(trafficBindingName);
      }
    },
  };
}

async function hotEdit(page: ProductPage, source: GuestSource, selector: string, edit: SourceEdit, traffic: Pick<ProductTraffic, "count" | "evidenceSince">, timeout: number): Promise<string> {
  const original = await source.read(edit.path);
  if (original === null || !original.includes(edit.search)) throw new Error(`HMR source marker missing in ${edit.path}`);
  if (!edit.search || edit.search === edit.replacement) throw new Error("HMR edit must change a nonempty source marker");
  const before = await traffic.count();
  try {
    await source.write(edit.path, original.replace(edit.search, edit.replacement));
    await page.locator(selector).filter({ hasText: edit.replacement }).waitFor({ timeout });
    const evidence = await traffic.evidenceSince(before);
    if (!evidence.length) throw new Error("Edited content appeared without a development WebSocket update (recognized Vite or Next HMR message)");
    return `Guest source edit rendered ${JSON.stringify(edit.replacement)} without a manual page reload after ${evidence.map(item => `${item.framework}:${item.event}`).join(", ")}`;
  } finally { await source.write(edit.path, original); }
}

async function featureProbe(page: ProductPage, base: string, probe: FeatureProbe, timeout: number): Promise<string> {
  const response = await page.goto(new URL(probe.path.replace(/^\/+/, ""), base.endsWith("/") ? base : base + "/").href, { timeout });
  if (!response) throw new Error(`No response for ${probe.path}`);
  if (probe.kind === "response") {
    if (response.status() !== probe.status) throw new Error(`${probe.path}: expected HTTP ${probe.status}, received ${response.status()}`);
    if (probe.text !== undefined && !(await response.text()).includes(probe.text)) throw new Error(`${probe.path}: response marker missing`);
    if (probe.header && response.headers()[probe.header.name.toLowerCase()] !== probe.header.value) throw new Error(`${probe.path}: response header ${probe.header.name} differs`);
    return `${probe.path}: HTTP ${probe.status} and requested body/header assertions`;
  }
  if (!response.ok()) throw new Error(`${probe.path}: HTTP ${response.status()}`);
  if (probe.kind === "action") await page.locator(probe.button).click({ timeout });
  await page.locator(probe.selector).filter({ hasText: probe.text }).waitFor({ timeout });
  return `${probe.path}: ${probe.kind} rendered ${JSON.stringify(probe.text)}`;
}

async function observe(stage: string, operation: () => Promise<string>): Promise<Observation> {
  try { return { stage, status: "pass", assertion: await operation() }; }
  catch (error) { return { stage, status: "fail", blocker: String(error) }; }
}

export async function productObservations(page: ProductPage, base: string, check: ProductCheck, source: GuestSource, traffic: Pick<ProductTraffic, "count" | "evidenceSince">, timeout: number): Promise<Observation[]> {
  if (check.kind !== "page" && check.kind !== "http") return [];
  const results: Observation[] = [];
  if (check.kind === "page" && check.hmr) {
    const edit = check.hmr;
    results.push(await observe("hmr", () => hotEdit(page, source, check.selector, edit, traffic, timeout)));
  }
  for (const probe of check.probes ?? []) results.push(await observe(probe.id, () => featureProbe(page, base, probe, timeout)));
  return results;
}

export function expectedObservations(check: ProductCheck): string[] {
  if (check.kind !== "page" && check.kind !== "http") return [];
  const hmr = check.kind === "page" && check.hmr ? ["hmr"] : [];
  return hmr.concat(Array.from(check.probes ?? [], probe => probe.id));
}

export function completeObservations(check: ProductCheck, observations: readonly Observation[], prerequisite: { status: string; blocker?: string }): Observation[] {
  const found = new Map(observations.map(row => [row.stage, row]));
  return expectedObservations(check).map(stage => found.get(stage) ?? {
    stage, status: "blocked", blocker: prerequisite.blocker ?? `Page stage ${prerequisite.status}; feature did not run`,
  });
}
