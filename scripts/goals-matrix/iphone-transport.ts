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
function previewDeadline(timeoutMs: number, admission: Admission): PreviewWait {
  const deadline = Math.min(Date.now() + timeoutMs, admission.deadline);
  return async (signal, stage, read, accept) => {
    let last: Row | null = null;
    const expired = (cause?: unknown) => new Error(`iPhone preview ${stage} did not finish within ${timeoutMs} ms; last observation: ${JSON.stringify(last)}`, { cause });
    // A read cut off by the deadline is the same expiry, not a separate observer failure.
    const fail = (error: unknown): never => { throw Date.now() >= deadline ? expired(error) : error; };
    while (true) {
      signal.throwIfAborted();
      admit(admission);
      const left = deadline - Date.now();
      if (left <= 0) throw expired();
      last = await read(left).catch(fail);
      if (accept(last)) return;
      await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())));
    }
  };
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
  async function settledRequest(selected: "host" | "preview", source: string, timeoutMs: number, observation: boolean, admission: Admission): Promise<IphoneSettlement> {
    admit(admission);
    const answer = object(await request(selected + "/execute", { source, timeoutMs, observation, deliverByMs: admission.deadline }, null));
    if (answer.settled !== true) throw new Error("iPhone observer response did not certify settlement");
    if (answer.ok === true && "value" in answer) return { settled: true, ok: true, value: answer.value };
    if (answer.ok === false && typeof answer.error === "string") return { settled: true, ok: false, error: answer.error };
    throw new Error("Malformed iPhone observer settlement");
  }
  function execute(selected: "host" | "preview", source: string, timeoutMs: number, admission: Admission, observation = false): Promise<unknown> {
    return lanes[selected].execute(() => settledRequest(selected, source, timeoutMs, observation, admission), admission);
  }
  async function evaluate<T>(source: string, admission: Admission, timeoutMs = observationTimeoutMs, observation = false): Promise<T> {
    return await execute(role, source, timeoutMs, admission, observation) as T;
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
      return awaitWithin(nativeClick(button, clicked, admission), admission);
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
      const wait = previewDeadline(config.timeoutMs, admission);
      admit(admission);
      await request("preview/configure", { url });
      const { signal, presentation } = await present(url, admission);
      if (presentation === null) throw new Error("Missing iPhone presentation identity");
      await wait(signal, "document", async left => { admit(admission); return object(await request("preview/state", undefined, left) ?? {}); }, attached);
      await wait(signal, "load", async left => object(await execute("preview", `(${iphonePreviewLoad.toString()})()`, left, admission, true)), row => row.loaded === true);
      await wait(signal, "focus", async left => { admit(admission); return object(await request("host/state", undefined, left) ?? {}); }, row => presentedFocus(row, presentation));
      signal.throwIfAborted();
      admit(admission);
      role = "preview";
      focused = true;
  }
  async function nativeClick(button: string, clicked: string, admission: Admission): Promise<unknown> {
      if (!focused) throw new Error("iPhone preview is not focused after load; refusing native input");
      const remaining = () => admit(admission);
      const trace = new IphoneClickTrace(config.saveNative, remaining(), lifetime.signal);
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
}
