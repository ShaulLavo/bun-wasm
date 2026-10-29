import type { FeatureProbe, ProductCheck, SourceEdit } from "./product-types";
import { boundedCleanup, HarnessCleanupError } from "./cleanup";

interface Locator {
  filter(options: { hasText: string }): Locator;
  waitFor(options: { timeout: number; state?: "hidden" }): Promise<void>;
  click(options: { timeout: number }): Promise<void>;
  count(): Promise<number>;
}
interface Response {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  headers(): Record<string, string>;
}
interface Disposable {
  dispose(): Promise<void>;
}
export interface ProductPage {
  addInitScript(script: () => void): Promise<Disposable>;
  exposeBinding(name: string, callback: (source: unknown, value: unknown) => void): Promise<Disposable>;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  locator(selector: string): Locator;
  goto(url: string, options: { timeout: number }): Promise<Response | null>;
}

interface ScriptControlSession {
  send(method: "Emulation.setScriptExecutionDisabled", params: { value: true }): Promise<unknown>;
  send(method: "Page.stopLoading" | "Runtime.getIsolateId"): Promise<unknown>;
}
/** A page in the preview's own browser context, so the probe shares its service worker, routing and redirects. */
export interface PreviewProbePage<Self> {
  context(): { newCDPSession(page: Self): Promise<ScriptControlSession> };
  goto(url: string, options: { timeout: number; waitUntil: "commit" }): Promise<Response | null>;
}

type PreviewBodyResult = { kind: "body"; body: string } | { kind: "deadline" };
type PreviewProbeOutcome = { kind: "ready" } | { kind: "starting"; body: string } | { kind: "deadline" };

async function readPreviewResponseBody(response: Response, deadline: number): Promise<PreviewBodyResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { kind: "deadline" };
  const deadlineToken = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(deadlineToken), remaining); }),
    ]);
    return { kind: "body", body };
  } catch (error) {
    if (error === deadlineToken) return { kind: "deadline" };
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePreview<Probe extends PreviewProbePage<Probe>>(probe: Probe, url: string, deadline: number): Promise<PreviewProbeOutcome> {
  let response: Response | null;
  try { response = await probe.goto(url, { timeout: Math.max(1, deadline - Date.now()), waitUntil: "commit" }); }
  catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") return { kind: "deadline" };
    throw error;
  }
  if (!response) throw new Error(`No response for preview ${url}`);
  if (response.ok()) return { kind: "ready" };
  const body = await readPreviewResponseBody(response, deadline);
  if (body.kind === "deadline") return body;
  if (response.status() === 503) return { kind: "starting", body: body.body };
  throw new Error(`Preview HTTP ${response.status()}: ${body.body}`);
}

async function pollPreviewReady<Probe extends PreviewProbePage<Probe>>(probe: Probe, url: string, deadline: number): Promise<void> {
  let last503: string | undefined;
  while (Date.now() < deadline) {
    const outcome = await probePreview(probe, url, deadline);
    if (outcome.kind === "ready") return;
    if (outcome.kind === "starting") last503 = outcome.body;
    if (outcome.kind === "deadline" || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
  throw new Error(`Preview was not HTTP-ready before the deadline: ${last503 === undefined ? "no complete response" : `last HTTP 503: ${last503 || "empty body"}`}`);
}

async function settlePreviewNavigation(session: ScriptControlSession, signal: AbortSignal): Promise<void> {
  try { await session.send("Page.stopLoading"); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Protocol error (Page.stopLoading): Not attached to an active page")) throw error;
  }
  signal.throwIfAborted();
  // Chromium holds renderer commands until a pending navigation commits or cancels. Closing
  // before that barrier can acknowledge Target.closeTarget without destroying the new frame.
  await session.send("Runtime.getIsolateId");
}

/**
 * Navigates a script-disabled probe until the preview stops answering HTTP 503, then settles
 * its navigation before the caller closes it. The probe never runs application scripts.
 */
export async function waitForPreviewReady<Probe extends PreviewProbePage<Probe>>(probe: Probe, url: string, deadline: number, cleanupTimeout: number): Promise<void> {
  const session = await probe.context().newCDPSession(probe);
  await session.send("Emulation.setScriptExecutionDisabled", { value: true });
  let pollingFailure: { error: unknown } | undefined;
  try { await pollPreviewReady(probe, url, deadline); }
  catch (error) { pollingFailure = { error }; }
  const controller = new AbortController();
  const failed = await boundedCleanup("probe-navigation-settlement", () => settlePreviewNavigation(session, controller.signal), cleanupTimeout);
  controller.abort();
  if (failed && pollingFailure) throw new HarnessCleanupError([failed], pollingFailure.error);
  if (failed) throw new HarnessCleanupError([failed]);
  if (pollingFailure) throw pollingFailure.error;
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
  durationMs?: number;
}
interface TrafficEvidence {
  sequence: number;
  framework: "next" | "vite";
  event: string;
  payload: string;
}
export interface ProductTraffic {
  beginEdit(): Promise<void>;
  count(): Promise<number>;
  evidenceSince(sequence: number): Promise<readonly TrafficEvidence[]>;
  close(): Promise<void>;
}

const trafficBindingName = "__bunWasmProductTrafficReport";

declare global {
  var __bunWasmProductTraffic: { beginEdit(): void; close(): void } | undefined;
  var __bunWasmProductTrafficReport: ((event: unknown) => Promise<unknown>) | undefined;
}

function installPreviewTrafficObserver() {
  const existing = globalThis.__bunWasmProductTraffic;
  if (existing) return;

  const nativeWebSocket = globalThis.WebSocket;
  const eventTarget = globalThis.EventTarget;
  const descriptor = Object.getOwnPropertyDescriptor(eventTarget.prototype, "dispatchEvent");
  if (!descriptor || typeof descriptor.value !== "function") return;

  const originalDispatch = descriptor.value;
  let editing = false;

  function textPayload(data: unknown): string | null {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    return null;
  }

  function frameworkPayload(target: EventTarget, event: Event): string | null {
    if (event.type !== "message") return null;
    if (typeof globalThis.WebSocket !== "function" || !(target instanceof globalThis.WebSocket)) return null;
    if (typeof nativeWebSocket === "function" && target instanceof nativeWebSocket) return null;
    return "data" in event ? textPayload(event.data) : null;
  }

  const wrappedDispatch = function (this: EventTarget, event: Event): boolean {
    try {
      const payload = frameworkPayload(this, event);
      if (payload !== null) void globalThis.__bunWasmProductTrafficReport?.({ payload, editing }).catch(() => {});
    } catch { }
    return Reflect.apply(originalDispatch, this, [event]);
  };

  Object.defineProperty(eventTarget.prototype, "dispatchEvent", { ...descriptor, value: wrappedDispatch });
  const state = {
    beginEdit() { editing = true; },
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

function frameworkTraffic(input: unknown): Omit<TrafficEvidence, "sequence"> | null {
  const payload = typeof input === "string" ? input : input instanceof Uint8Array ? new TextDecoder().decode(Uint8Array.from(input)) : null;
  if (payload === null || payload.length > 262144) return null;
  const nextActions = new Set([
    "reloadPage", "serverComponentChanges", "clientChanges",
    "serverOnlyChanges", "middlewareChanges", "addedPage", "removedPage",
  ]);
  const nextEvents = new Set(["clientChanges", "serverOnlyChanges", "middlewareChanges"]);
  let message: unknown;
  try { message = JSON.parse(payload); }
  catch { return null; }
  if (!message || typeof message !== "object") return null;

  const type = stringProperty(message, "type");
  if (type === "full-reload") return { framework: "vite", event: type, payload };
  const updates = Reflect.get(message, "updates");
  if (type === "update" && Array.isArray(updates) && updates.some(meaningfulUpdate)) return { framework: "vite", event: type, payload };
  const action = stringProperty(message, "action") ?? type;
  if (action === "built" && stringProperty(message, "hash")) return { framework: "next", event: action, payload };
  if (action && nextActions.has(action)) return { framework: "next", event: action, payload };
  const eventName = stringProperty(message, "event");
  if (eventName && nextEvents.has(eventName)) return { framework: "next", event: eventName, payload };
  return null;
}

function meaningfulUpdate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const kind = stringProperty(value, "type");
  return (kind === "js-update" || kind === "css-update") && Boolean(stringProperty(value, "path"));
}

function stringProperty(value: object, key: string): string | null {
  const candidate = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : null;
}


class TrafficLog {
  private readonly events: TrafficEvidence[] = [];
  private sequence = 0;
  record(payload: unknown): void {
    const event = frameworkTraffic(payload);
    if (!event) return;
    this.events.push({ ...event, sequence: ++this.sequence });
    if (this.events.length > 256) this.events.shift();
  }
  count(): number { return this.sequence; }
  since(sequence: number): TrafficEvidence[] { return this.events.filter(event => event.sequence > sequence).map(event => ({ ...event })); }
}

export async function observeProductTraffic(page: ProductPage): Promise<ProductTraffic> {
  const log = new TrafficLog();
  const receive = (_source: unknown, value: unknown): void => {
    if (!value || typeof value !== "object" || !("editing" in value) || value.editing !== true || !("payload" in value)) return;
    log.record(value.payload);
  };
  const binding = await page.exposeBinding(trafficBindingName, receive);
  let script: Disposable;
  try { script = await page.addInitScript(installPreviewTrafficObserver); }
  catch (error) { await binding.dispose(); throw error; }
  let closed = false;
  return {
    beginEdit: () => page.evaluate(() => {
      const state = globalThis.__bunWasmProductTraffic;
      if (!state) throw new Error("Preview traffic observer is not installed");
      state.beginEdit();
    }),
    count: async () => log.count(),
    evidenceSince: async sequence => log.since(sequence),
    close: async () => {
      if (closed) return;
      try { await page.evaluate(closePreviewTrafficObserver); }
      finally {
        closed = true;
        await Promise.all([script.dispose(), binding.dispose()]);
      }
    },
  };
}

interface NativeSocket {
  on(event: "framereceived", listener: (frame: { payload: unknown }) => void): unknown;
  off(event: "framereceived", listener: (frame: { payload: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}
interface NativeTrafficPage {
  on(event: "websocket", listener: (socket: NativeSocket) => void): unknown;
  off(event: "websocket", listener: (socket: NativeSocket) => void): unknown;
}

/** Native roots use browser-delivered events, which bypass JavaScript dispatchEvent. */
export async function observeNativeProductTraffic(page: NativeTrafficPage): Promise<ProductTraffic> {
  const log = new TrafficLog();
  const sockets = new Map<NativeSocket, { receive(frame: { payload: unknown }): void; close(): void }>();
  let editing = false;
  let closed = false;
  const connected = (socket: NativeSocket) => {
    if (closed) return;
    const receive = ({ payload }: { payload: unknown }) => { if (editing && !closed) log.record(payload); };
    const close = () => { socket.off("framereceived", receive); socket.off("close", close); sockets.delete(socket); };
    sockets.set(socket, { receive, close });
    socket.on("framereceived", receive);
    socket.on("close", close);
  };
  page.on("websocket", connected);
  return {
    beginEdit: async () => { editing = true; },
    count: async () => log.count(),
    evidenceSince: async sequence => log.since(sequence),
    close: async () => {
      if (closed) return;
      closed = true; editing = false;
      page.off("websocket", connected);
      for (const [socket, observer] of sockets) { socket.off("framereceived", observer.receive); socket.off("close", observer.close); }
      sockets.clear();
    },
  };
}

type EditTraffic = Pick<ProductTraffic, "beginEdit" | "count" | "evidenceSince">;

async function editEvidence(traffic: EditTraffic, before: number, deadline: number): Promise<readonly TrafficEvidence[]> {
  while (true) {
    const evidence = await traffic.evidenceSince(before);
    if (evidence.length || Date.now() >= deadline) return evidence;
    await new Promise(resolve => setTimeout(resolve, Math.min(10, deadline - Date.now())));
  }
}

async function hotEdit(page: ProductPage, source: GuestSource, selector: string, edit: SourceEdit, traffic: EditTraffic, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  const original = await source.read(edit.path);
  if (original === null || !original.includes(edit.search)) throw new Error(`HMR source marker missing in ${edit.path}`);
  if (!edit.search || edit.search === edit.replacement) throw new Error("HMR edit must change a nonempty source marker");
  await page.locator(selector).filter({ hasText: edit.search }).waitFor({ timeout });
  if (await page.locator(selector).filter({ hasText: edit.replacement }).count()) throw new Error("HMR replacement text is already visible before the edit");
  await traffic.beginEdit();
  const before = await traffic.count();
  let evidence: readonly TrafficEvidence[];
  try {
    await source.write(edit.path, original.replace(edit.search, edit.replacement));
    await page.locator(selector).filter({ hasText: edit.replacement }).waitFor({ timeout: Math.max(1, deadline - Date.now()) });
    evidence = await editEvidence(traffic, before, deadline);
    if (!evidence.length) throw new Error("Edited content appeared without a development WebSocket update (recognized Vite or Next HMR message)");
  } catch (error) {
    try { await source.write(edit.path, original); }
    catch { /* Cleanup must not replace the original forward failure. */ }
    throw error;
  }
  await traffic.beginEdit();
  const rollback = await traffic.count();
  await source.write(edit.path, original);
  await page.locator(selector).filter({ hasText: edit.replacement }).waitFor({ state: "hidden", timeout: Math.max(1, deadline - Date.now()) });
  await page.locator(selector).filter({ hasText: edit.search }).waitFor({ timeout: Math.max(1, deadline - Date.now()) });
  const restored = await editEvidence(traffic, rollback, deadline);
  if (!restored.length) throw new Error("Restored source appeared without a development WebSocket update (recognized Vite or Next HMR message)");
  return `Guest source edit rendered ${JSON.stringify(edit.replacement)} without a manual page reload after ${evidence.map(item => `${item.framework}:${item.event}`).join(", ")}`;
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
  const started = performance.now();
  const durationMs = () => Math.round(performance.now() - started);
  try { return { stage, status: "pass", assertion: await operation(), durationMs: durationMs() }; }
  catch (error) { return { stage, status: "fail", blocker: String(error), durationMs: durationMs() }; }
}

export async function productObservations(page: ProductPage, base: string, check: ProductCheck, source: GuestSource, traffic: EditTraffic, timeout: number): Promise<Observation[]> {
  if (check.kind !== "page" && check.kind !== "http") return [];
  const results: Observation[] = [];
  if (check.kind === "page" && check.hmr) {
    const edit = check.hmr;
    results.push(await observe("hmr", () => hotEdit(page, source, check.selector, edit, traffic, timeout)));
  }
  for (const probe of check.probes ?? []) results.push(await observe(probe.id, () => featureProbe(page, base, probe, timeout)));
  return results;
}

function expectedObservations(check: ProductCheck): string[] {
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
