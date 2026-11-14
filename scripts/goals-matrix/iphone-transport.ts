import { isAbsolute } from "node:path";
import type { Transport } from "./transport";
import { admit, awaitWithin, type Admission } from "./scope";
import { IphoneLane } from "./iphone-lane";
import type { IphoneSettlement } from "./iphone-bus";
import { ownedCommand } from "./lifetime";
import { until } from "./playground";
import { armIphoneClick, iphonePreviewLoad, presentIphonePreview } from "./iphone-browser";
import { object } from "./evidence";
import { closeIphoneTab } from "./iphone-cleanup";
import { IphoneClickTrace, iphoneClickExpression, iphoneClickPredicates, saveIphoneEvidence } from "./iphone-click";

type Config = { control: string; agent: string; deviceUDID: string; timeoutMs: number; cleanupTimeoutMs?: number; saveNative?(text: string): Promise<void> };
export function validateIphoneControl(control: string, agent: string): void {
  const url = new URL(control);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^\/__goals_iphone\/[a-f0-9]{64}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error("Expected forwarded loopback iPhone control URL");
  if (!isAbsolute(agent) || !agent.endsWith("/agent-device")) throw new Error("Use the exact absolute command returned by T3 device_open");
}
export function nativeButtonRef(snapshot: string, label: string): string {
  const matches = Array.from(snapshot.matchAll(/^(@e\d+(?:~s\d+)?) \[button\] "([^\n]*)"/gm)).filter(match => match[2] === label);
  if (matches.length !== 1 || !matches[0]?.[1]) throw new Error(`Expected one visible native button named ${JSON.stringify(label)}, found ${matches.length}`);
  return matches[0][1];
}
type Row = Record<string, unknown>;
type PreviewStage = "configure" | "presentation" | "document" | "load" | "focus" | "open-preview-complete";
class IphonePreviewEvidence {
  private readonly id = crypto.randomUUID();
  private progress: PreviewStage = "configure";
  private previous = "";
  private changes = 0;
  private ended = false;
  private readonly abort = () => this.finish("cancelled");
  constructor(private readonly save: Config["saveNative"], private readonly signal: AbortSignal) {
    this.stage("configure");
    if (signal.aborted) this.abort();
    else signal.addEventListener("abort", this.abort, { once: true });
  }
  private emit(row: object): void { saveIphoneEvidence(this.save, { event: "iphone-preview", previewId: this.id, ...row }); }
  stage(stage: PreviewStage): void {
    if (this.ended) return;
    this.progress = stage;
    this.previous = "";
    this.changes = 0;
    this.emit({ stage });
  }
  observed(row: Row, presentation: string): void {
    if (this.ended) return;
    const observation = previewObservation(this.progress, row, presentation);
    const serialized = JSON.stringify(observation);
    if (serialized === this.previous) return;
    this.previous = serialized;
    // Keep changing observations bounded without losing the final state at cancellation.
    if (this.changes++ < 12) this.emit({ stage: this.progress, observation });
  }
  finish(outcome: "returned" | "failed" | "cancelled"): void {
    if (this.ended) return;
    this.ended = true;
    this.signal.removeEventListener("abort", this.abort);
    this.emit({ stage: this.progress, outcome, observation: this.previous ? JSON.parse(this.previous) : undefined });
  }
}
function previewObservation(stage: PreviewStage, row: Row, presentation: string): object {
  if (stage === "document") return { attached: attached(row), visible: row.visible === true, hasTimeOrigin: typeof row.timeOrigin === "number" };
  if (stage === "load") return { loaded: row.loaded === true, readyState: row.readyState === "loading" || row.readyState === "interactive" || row.readyState === "complete" ? row.readyState : "unknown" };
  const focus = row.previewFocus;
  if (!focus || typeof focus !== "object") return { presented: false, focused: false, matchesPresentation: false };
  return { presented: "presented" in focus && focus.presented === true, focused: "focused" in focus && focus.focused === true,
    matchesPresentation: "presentation" in focus && focus.presentation === presentation };
}
type RenderRequest = { request: number; dispatched: boolean; delivered: "unknown" | "confirmed" | "expired"; settled: boolean; result?: { text: string; matched: boolean } };
class IphoneRenderEvidence {
  private readonly id = crypto.randomUUID();
  private first: RenderRequest | undefined;
  private last: RenderRequest | undefined;
  private count = 0;
  ended = false;
  private readonly signal: AbortSignal;
  private readonly abort = () => this.finish("cancelled");
  constructor(private readonly save: Config["saveNative"], readonly admission: Admission, lifetime: AbortSignal) {
    this.signal = AbortSignal.any([admission.signal, lifetime]);
    this.signal.addEventListener("abort", this.abort, { once: true });
  }
  private emit(outcome: string): void { saveIphoneEvidence(this.save, { event: "iphone-rendered", renderId: this.id, outcome, requests: this.count, first: this.first, last: this.last }); }
  requested(): RenderRequest {
    const request: RenderRequest = { request: ++this.count, dispatched: false, delivered: "unknown", settled: false };
    this.first ??= request;
    this.last = request;
    if (this.count === 1) this.emit("requested");
    return request;
  }
  dispatched(request: RenderRequest): void {
    if (this.ended) return;
    request.dispatched = true;
    if (request === this.first) this.emit("dispatched");
  }
  settled(request: RenderRequest, answer: IphoneSettlement): void {
    if (this.ended) return;
    request.settled = true;
    if (answer.ok) {
      request.delivered = "confirmed";
      request.result = renderedObservation(answer.value);
    }
    if (!answer.ok && answer.error === "Error: iPhone observer delivery deadline expired") request.delivered = "expired";
    if (request === this.first) this.emit("settled");
    if (!answer.ok || request.result?.matched) this.finish(answer.ok ? "matched" : "observer-failed");
  }
  finish(outcome: string): void {
    if (this.ended) return;
    this.ended = true;
    this.signal.removeEventListener("abort", this.abort);
    this.emit(outcome);
  }
}
function renderedObservation(value: unknown): RenderRequest["result"] {
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || !("matched" in value) || typeof value.matched !== "boolean") return;
  return { text: value.text.slice(0, 200), matched: value.matched };
}
const attached = (row: Row): boolean => typeof row.timeOrigin === "number" && row.visible === true;
function presentedFocus(row: Row, presentation: string): boolean {
  const focus = row.previewFocus;
  return focus !== null && typeof focus === "object" && "presentation" in focus && focus.presentation === presentation && "focused" in focus && focus.focused === true;
}
type PreviewWait = (signal: AbortSignal, stage: string, read: (timeoutMs: number) => Promise<Row>, accept: (row: Row) => boolean) => Promise<void>;
/**
 * One deadline for opening a preview. Each stage polls short reads, and starts none after the
 * deadline or after `signal` aborts, so a preview that never loads leaves no controller command
 * pending behind it. An expiry names its stage and the last state it read.
 */
function previewDeadline(timeoutMs: number, admission: Admission, observed: (row: Row) => void): PreviewWait {
  const deadline = Math.min(Date.now() + timeoutMs, admission.deadline);
  return (signal, stage, read, accept) => waitPreview({ timeoutMs, deadline, admission, signal, stage, read, accept, observed });
}
async function waitPreview(options: { timeoutMs: number; deadline: number; admission: Admission; signal: AbortSignal; stage: string; read: Parameters<PreviewWait>[2]; accept: Parameters<PreviewWait>[3]; observed(row: Row): void }): Promise<void> {
  const { timeoutMs, deadline, admission, signal, stage, read, accept } = options;
  let last: Row | null = null;
  const expired = (cause?: unknown) => new Error(`iPhone preview ${stage} did not finish within ${timeoutMs} ms; last observation: ${JSON.stringify(last)}`, { cause });
  const fail = (error: unknown): never => { throw Date.now() >= deadline ? expired(error) : error; };
  while (true) {
    signal.throwIfAborted();
    admit(admission);
    const left = deadline - Date.now();
    if (left <= 0) throw expired();
    last = await read(left).catch(fail);
    options.observed(last);
    if (accept(last)) return;
    await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}

export async function createIphoneTransport(config: Config): Promise<Transport> {
  validateIphoneControl(config.control, config.agent);
  let role: "host" | "preview" = "host";
  // True only while the presented frame has loaded and its load listener focused it.
  let focused = false;
  // Owns the wait on the presented frame. A presentation change ends it; so does the start of cleanup, for good.
  let opening = new AbortController();
  const cleaning = new AbortController();
  let opened = false;
  let deviceFailed = false;
  let title = "";
  let closing: Promise<void> | undefined;
  let observationTimeoutMs = config.timeoutMs;
  const lifetime = new AbortController();
  let rendered: IphoneRenderEvidence | undefined;
  const active = new Set<Promise<string>>();
  const capabilities: Record<string, unknown> = { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": config.deviceUDID, transport: "visible-safari-xctest", safariDriverSession: false };
  async function request(action: string, value?: object, timeoutMs: number | null = observationTimeoutMs): Promise<unknown> {
    const response = await fetch(config.control + "/" + action, { method: value ? "POST" : "GET", headers: value ? { "content-type": "application/json" } : {},
      body: value ? JSON.stringify(value) : undefined, signal: timeoutMs === null ? lifetime.signal : AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]) });
    const answer: unknown = await response.json();
    if (!response.ok) throw new Error(`iPhone observer: ${JSON.stringify(answer)}`);
    return answer;
  }
  async function device(args: string[], timeoutMs: number, signal = lifetime.signal): Promise<string> {
    signal.throwIfAborted();
    const action = ownedCommand([config.agent].concat(args), signal, timeoutMs);
    active.add(action);
    try {
      const output = await action;
      saveIphoneEvidence(config.saveNative, { command: [config.agent].concat(args), output });
      return output;
    } catch (error) {
      deviceFailed = true;
      saveIphoneEvidence(config.saveNative, { command: [config.agent].concat(args), error: String(error) });
      throw new Error(`T3 device command failed: ${String(error)}`);
    } finally { active.delete(action); }
  }
  const lanes = { host: new IphoneLane(), preview: new IphoneLane() };
  async function settledRequest(selected: "host" | "preview", source: string, timeoutMs: number, observation: boolean, admission: Admission, trace?: { evidence: IphoneRenderEvidence; request: RenderRequest }): Promise<IphoneSettlement> {
    admit(admission);
    trace?.evidence.dispatched(trace.request);
    const answer = object(await request(selected + "/execute", { source, timeoutMs, observation, deliverByMs: admission.deadline }, null));
    if (answer.settled !== true) throw new Error("iPhone observer response did not certify settlement");
    const result = settlement(answer);
    trace?.evidence.settled(trace.request, result);
    return result;
  }
  function execute(selected: "host" | "preview", source: string, timeoutMs: number, admission: Admission, observation = false, trace?: { evidence: IphoneRenderEvidence; request: RenderRequest }): Promise<unknown> {
    return lanes[selected].execute(() => settledRequest(selected, source, timeoutMs, observation, admission, trace), admission);
  }
  async function evaluate<T>(source: string, admission: Admission, timeoutMs = observationTimeoutMs, observation = false): Promise<T> {
    admit(admission);
    const evidence = renderEvidence(source, admission, observation);
    const trace = evidence ? { evidence, request: evidence.requested() } : undefined;
    try { return await execute(role, source, timeoutMs, admission, observation, trace) as T; }
    catch (error) { evidence?.finish("request-failed"); throw error; }
  }
  function renderEvidence(source: string, admission: Admission, observation: boolean): IphoneRenderEvidence | undefined {
    if (!config.saveNative || role !== "preview" || !observation || !source.startsWith("(function rendered(")) return;
    if (rendered?.admission === admission && !rendered.ended) return rendered;
    rendered?.finish("superseded");
    return rendered = new IphoneRenderEvidence(config.saveNative, admission, lifetime.signal);
  }
  // Every presentation change ends the wait on the previous frame and withdraws its focus record.
  async function present(url: string | null, admission: Admission): Promise<{ signal: AbortSignal; presentation: string | null }> {
    admit(admission);
    role = "host";
    focused = false;
    opening.abort(new Error("iPhone preview presentation changed"));
    opening = new AbortController();
    const signal = AbortSignal.any([opening.signal, cleaning.signal, admission.signal]);
    const presentation = await evaluate<unknown>(`(${presentIphonePreview.toString()})(${JSON.stringify(url)})`, admission);
    if (presentation !== null && typeof presentation !== "string") throw new Error("Invalid iPhone presentation identity");
    if (url !== null && !presentation) throw new Error("Missing iPhone presentation identity");
    return { signal, presentation };
  }
  async function close(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    lifetime.abort(new Error("iPhone transport closing"));
    await Promise.allSettled(Array.from(active));
    if (deviceFailed) throw new Error("T3 device command failed; stopping device interactions, task tab cleanup is unproved");
    if (!opened) return;
    await closeIphoneTab(device, title, deadline);
    opened = false;
  }
  return {
    capabilities,
    beginCleanup() {
      focused = false;
      observationTimeoutMs = config.cleanupTimeoutMs ?? config.timeoutMs;
      cleaning.abort(new Error("iPhone cleanup began before the preview opened"));
    },
    async navigate(url, admission) {
      admit(admission);
      return awaitWithin(navigate(url, admission), admission);
    },
    evaluate: <T>(source: string, admission: Admission, options?: Parameters<Transport["evaluate"]>[2]) => evaluate<T>(source, admission, observationTimeoutMs, options?.observation === true),
    async openPreview(url, admission) {
      admit(admission);
      return awaitWithin(openPreview(url, admission), admission);
    },
    async useHost(admission) { admit(admission); role = "host"; },
    async usePreview(admission) { admit(admission); role = "preview"; },
    async closePreview(admission) { admit(admission); await present(null, admission); },
    async cleanup(timeoutMs) {
      await (closing ??= close(timeoutMs));
      return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    },
    async nativeClick(button, clicked, admission) {
      admit(admission);
      if (!focused) throw new Error("iPhone preview is not focused after load; refusing native input");
      return awaitWithin(nativeClick({ button, clicked, admission, evaluate, device, saveNative: config.saveNative, signal: lifetime.signal }), admission);
    },
    close(_interruptPending = false, timeoutMs = 10_000) { return closing ??= close(timeoutMs); },
  };
  async function navigate(url: string, admission: Admission): Promise<void> {
      admit(admission);
      const target = await request("host/configure", { url });
      if (typeof target !== "string") throw new Error("Missing iPhone navigation target");
      admit(admission);
      await device(["open", "com.apple.mobilesafari", target], config.timeoutMs); opened = true;
      const state = await until(async () => { admit(admission); return object(await request("host/state") ?? {}); }, attached, config.timeoutMs);
      if (typeof state.userAgent !== "string" || !/iPhone.*Safari/.test(state.userAgent)) throw new Error("Observer did not identify iPhone Safari");
      admit(admission);
      capabilities.userAgent = state.userAgent;
      if (typeof state.nonce !== "string") throw new Error("Missing task tab identity");
      title = "Goals " + state.nonce;
  }
  async function openPreview(url: string, admission: Admission): Promise<void> {
      const trace = new IphonePreviewEvidence(config.saveNative, AbortSignal.any([admission.signal, lifetime.signal, cleaning.signal]));
      try { await openingPreview(url, admission, trace); trace.finish("returned"); }
      finally { trace.finish("failed"); }
  }
  async function openingPreview(url: string, admission: Admission, trace: IphonePreviewEvidence): Promise<void> {
      let identity = "";
      const wait = previewDeadline(config.timeoutMs, admission, row => trace.observed(row, identity));
      admit(admission);
      await request("preview/configure", { url });
      trace.stage("presentation");
      const { signal, presentation } = await present(url, admission);
      if (presentation === null) throw new Error("Missing iPhone presentation identity");
      identity = presentation;
      trace.stage("document");
      await wait(signal, "document", async left => { admit(admission); return object(await request("preview/state", undefined, left) ?? {}); }, attached);
      trace.stage("load");
      await wait(signal, "load", async left => object(await execute("preview", `(${iphonePreviewLoad.toString()})()`, left, admission, true)), row => row.loaded === true);
      trace.stage("focus");
      await wait(signal, "focus", async left => { admit(admission); return object(await request("host/state", undefined, left) ?? {}); }, row => presentedFocus(row, presentation));
      signal.throwIfAborted();
      admit(admission);
      role = "preview";
      focused = true;
      trace.stage("open-preview-complete");
  }

}

function settlement(answer: Row): IphoneSettlement {
  if (answer.ok === true && "value" in answer) return { settled: true, ok: true, value: answer.value };
  if (answer.ok === false && typeof answer.error === "string") return { settled: true, ok: false, error: answer.error };
  throw new Error("Malformed iPhone observer settlement");
}

async function nativeClick(options: {
  button: string; clicked: string; admission: Admission; saveNative: Config["saveNative"]; signal: AbortSignal;
  evaluate<T>(source: string, admission: Admission, timeoutMs?: number): Promise<T>;
  device(args: string[], timeoutMs: number): Promise<string>;
}): Promise<unknown> {
  const { button, clicked, admission, evaluate, device, saveNative, signal } = options;
  const remaining = () => admit(admission);
  const trace = new IphoneClickTrace(saveNative, remaining(), signal);
  try {
    const before = await until(async () => object(await evaluate(`(${armIphoneClick.toString()})(${JSON.stringify(button)},${JSON.stringify(clicked)})`, admission, remaining())), value => value.ready === true, remaining());
    if (typeof before.label !== "string" || typeof before.before !== "string") throw new Error("Missing native click target");
    const expected = before.before.replace(/\b0\b/, "1");
    trace.armed(before, expected);
    trace.stage("snapshot-pending");
    const snapshot = await device(["snapshot", "-i"], remaining());
    trace.stage("snapshot-returned");
    const ref = nativeButtonRef(snapshot, before.label);
    trace.stage("press-pending");
    await device(["press", ref], remaining());
    trace.stage("press-returned");
    const expression = iphoneClickExpression(button, clicked);
    const observe = async () => {
      const left = remaining();
      trace.observing();
      const value = await evaluate<Record<string, unknown>>(expression, admission, left);
      trace.observed(iphoneClickPredicates(before, value, expected));
      return value;
    };
    const after = await until(observe, value => value.trusted === true && value.sameTarget === true && value.url === before.url && value.timeOrigin === before.timeOrigin && value.nonce === before.nonce && value.after === expected, remaining());
    trace.finish("passed");
    return { before: before.before, after: after.after, trusted: true, nativeRef: ref, inputMethod: "T3 device_open XCTest" };
  } finally { trace.finish("failed"); }
}
