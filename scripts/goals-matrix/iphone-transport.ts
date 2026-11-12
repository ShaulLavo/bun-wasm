import { isAbsolute } from "node:path";
import type { Transport } from "./transport";
import { ownedCommand } from "./lifetime";
import { until } from "./playground";
import { armIphoneClick, iphonePreviewFocus, iphonePreviewLoad, presentIphonePreview } from "./iphone-browser";
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
type PreviewWait = (stage: string, read: (timeoutMs: number) => Promise<Row>, accept: (row: Row) => boolean) => Promise<void>;
/**
 * One deadline for opening a preview. Each stage polls short reads, and starts none after the
 * deadline or after `signal` aborts, so a preview that never loads leaves no controller command
 * pending behind it. An expiry names its stage and the last state it read.
 */
function previewDeadline(timeoutMs: number, signal: AbortSignal): PreviewWait {
  const deadline = Date.now() + timeoutMs;
  return async (stage, read, accept) => {
    let last: Row | null = null;
    const expired = (cause?: unknown) => new Error(`iPhone preview ${stage} did not finish within ${timeoutMs} ms; last observation: ${JSON.stringify(last)}`, { cause });
    // A read cut off by the deadline is the same expiry, not a separate observer failure.
    const fail = (error: unknown): never => { throw Date.now() >= deadline ? expired(error) : error; };
    while (true) {
      signal.throwIfAborted();
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
  // Owns the wait on the presented frame. A presentation change or the start of cleanup ends it.
  let opening = new AbortController();
  let opened = false;
  let deviceFailed = false;
  let title = "";
  let closing: Promise<void> | undefined;
  let observationTimeoutMs = config.timeoutMs;
  const lifetime = new AbortController();
  const active = new Set<Promise<string>>();
  const capabilities: Record<string, unknown> = { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": config.deviceUDID, transport: "visible-safari-xctest", safariDriverSession: false };
  async function request(action: string, value?: object, timeoutMs = observationTimeoutMs): Promise<unknown> {
    const response = await fetch(config.control + "/" + action, { method: value ? "POST" : "GET", headers: value ? { "content-type": "application/json" } : {},
      body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]) });
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
  function execute(selected: "host" | "preview", source: string, timeoutMs: number, observation = false): Promise<unknown> {
    return request(selected + "/execute", { source, timeoutMs, observation }, timeoutMs);
  }
  async function evaluate<T>(source: string, timeoutMs = observationTimeoutMs, observation = false): Promise<T> {
    return await execute(role, source, timeoutMs, observation) as T;
  }
  async function present(url: string | null): Promise<void> {
    role = "host";
    focused = false;
    opening.abort(new Error("iPhone preview presentation changed"));
    await evaluate(`(${presentIphonePreview.toString()})(${JSON.stringify(url)})`);
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
      observationTimeoutMs = config.cleanupTimeoutMs ?? config.timeoutMs;
      opening.abort(new Error("iPhone cleanup began before the preview opened"));
    },
    async navigate(url) {
      const target = await request("host/configure", { url });
      if (typeof target !== "string") throw new Error("Missing iPhone navigation target");
      await device(["open", "com.apple.mobilesafari", target], config.timeoutMs); opened = true;
      const state = await until(async () => object(await request("host/state") ?? {}), attached, config.timeoutMs);
      if (typeof state.userAgent !== "string" || !/iPhone.*Safari/.test(state.userAgent)) throw new Error("Observer did not identify iPhone Safari");
      capabilities.userAgent = state.userAgent;
      if (typeof state.nonce !== "string") throw new Error("Missing task tab identity");
      title = "Goals " + state.nonce;
    },
    evaluate: <T>(source: string, options?: Parameters<Transport["evaluate"]>[1]) => evaluate<T>(source, observationTimeoutMs, options?.observation === true),
    async openPreview(url) {
      const current = new AbortController();
      const wait = previewDeadline(config.timeoutMs, current.signal);
      await request("preview/configure", { url });
      await present(url);
      opening = current;
      // The owner role stays free for terminal and diagnostic reads until the preview document completes.
      await wait("document", async left => object(await request("preview/state", undefined, left) ?? {}), attached);
      await wait("load", async left => object(await execute("preview", `(${iphonePreviewLoad.toString()})()`, left, true)), row => row.loaded === true);
      await wait("focus", async left => object(await execute("host", `(${iphonePreviewFocus.toString()})()`, left)), row => row.focused === true);
      current.signal.throwIfAborted();
      role = "preview";
      focused = true;
    },
    async useHost() { role = "host"; },
    async usePreview() { role = "preview"; },
    async closePreview() { await present(null); },
    async cleanup(timeoutMs) {
      await (closing ??= close(timeoutMs));
      return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    },
    async nativeClick(button, clicked, timeoutMs) {
      if (!focused) throw new Error("iPhone preview is not focused after load; refusing native input");
      const deadline = Date.now() + timeoutMs;
      const remaining = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error("iPhone click deadline expired"); return left; };
      const trace = new IphoneClickTrace(config.saveNative, timeoutMs, lifetime.signal);
      try {
        const before = await until(async () => object(await evaluate(`(${armIphoneClick.toString()})(${JSON.stringify(button)},${JSON.stringify(clicked)})`, remaining())), value => value.ready === true, remaining());
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
          const value = await evaluate<Record<string, unknown>>(expression, left);
          trace.observed(iphoneClickPredicates(before, value, expected));
          return value;
        };
        const after = await until(observe, value => value.trusted === true && value.sameTarget === true && value.url === before.url && value.timeOrigin === before.timeOrigin && value.nonce === before.nonce && value.after === expected, remaining());
        trace.finish("passed");
        return { before: before.before, after: after.after, trusted: true, nativeRef: ref, inputMethod: "T3 device_open XCTest" };
      } finally { trace.finish("failed"); }
    },
    close(_interruptPending = false, timeoutMs = 10_000) { return closing ??= close(timeoutMs); },
  };
}
