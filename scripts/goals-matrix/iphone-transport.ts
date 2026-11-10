import { isAbsolute } from "node:path";
import type { Transport } from "./transport";
import { ownedCommand } from "./lifetime";
import { until } from "./playground";
import { armIphoneClick, presentIphonePreview } from "./iphone-browser";
import { object } from "./evidence";
import { closeIphoneTab } from "./iphone-cleanup";
import { IphoneClickTrace, iphoneClickExpression, iphoneClickPredicates, saveIphoneEvidence } from "./iphone-click";

type Config = { control: string; agent: string; deviceUDID: string; timeoutMs: number; saveNative?(text: string): Promise<void> };
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
export async function createIphoneTransport(config: Config): Promise<Transport> {
  validateIphoneControl(config.control, config.agent);
  let role: "host" | "preview" = "host";
  let opened = false;
  let deviceFailed = false;
  let title = "";
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const active = new Set<Promise<string>>();
  const capabilities: Record<string, unknown> = { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": config.deviceUDID, transport: "visible-safari-xctest", safariDriverSession: false };
  async function request(action: string, value?: object, timeoutMs = config.timeoutMs): Promise<unknown> {
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
  async function evaluate<T>(source: string, timeoutMs = config.timeoutMs, observation = false): Promise<T> {
    return await request(role + "/execute", { source, timeoutMs, observation }, timeoutMs) as T;
  }
  async function ready(selected: "host" | "preview"): Promise<Record<string, unknown>> {
    return until(async () => object(await request(selected + "/state") ?? {}), row => typeof row.timeOrigin === "number" && row.visible === true, config.timeoutMs);
  }
  async function present(url: string | null): Promise<void> {
    role = "host";
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
    async navigate(url) {
      const target = await request("host/configure", { url });
      if (typeof target !== "string") throw new Error("Missing iPhone navigation target");
      await device(["open", "com.apple.mobilesafari", target], config.timeoutMs); opened = true;
      const state = await ready("host");
      if (typeof state.userAgent !== "string" || !/iPhone.*Safari/.test(state.userAgent)) throw new Error("Observer did not identify iPhone Safari");
      capabilities.userAgent = state.userAgent;
      if (typeof state.nonce !== "string") throw new Error("Missing task tab identity");
      title = "Goals " + state.nonce;
    },
    evaluate: <T>(source: string, options?: Parameters<Transport["evaluate"]>[1]) => evaluate<T>(source, config.timeoutMs, options?.observation === true),
    async openPreview(url) {
      await request("preview/configure", { url });
      await present(url);
      await ready("preview"); role = "preview";
    },
    async useHost() { role = "host"; },
    async usePreview() { role = "preview"; },
    async closePreview() { await present(null); },
    async cleanup(timeoutMs) {
      await (closing ??= close(timeoutMs));
      return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    },
    async nativeClick(button, clicked, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const remaining = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error("iPhone click deadline expired"); return left; };
      const trace = new IphoneClickTrace(config.saveNative, timeoutMs, lifetime.signal);
      try {
        const before = object(await evaluate(`(${armIphoneClick.toString()})(${JSON.stringify(button)},${JSON.stringify(clicked)})`, remaining()));
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
