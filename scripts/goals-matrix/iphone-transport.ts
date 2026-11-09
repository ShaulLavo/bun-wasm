import { isAbsolute } from "node:path";
import type { Transport } from "./transport";
import { ownedCommand } from "./lifetime";
import { until } from "./playground";
import { armIphoneClick, presentIphonePreview } from "./iphone-browser";
import { object } from "./evidence";

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
  const capabilities: Record<string, unknown> = { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": config.deviceUDID, transport: "visible-safari-xctest", safariDriverSession: false };
  async function request(action: string, value?: object): Promise<unknown> {
    const response = await fetch(config.control + "/" + action, { method: value ? "POST" : "GET", headers: value ? { "content-type": "application/json" } : {},
      body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(config.timeoutMs) });
    const answer: unknown = await response.json();
    if (!response.ok) throw new Error(`iPhone observer: ${JSON.stringify(answer)}`);
    return answer;
  }
  async function device(args: string[], timeoutMs: number): Promise<string> {
    try {
      const output = await ownedCommand([config.agent].concat(args), undefined, timeoutMs);
      await config.saveNative?.(JSON.stringify({ command: [config.agent].concat(args), output, at: new Date().toISOString() }) + "\n");
      return output;
    } catch (error) {
      deviceFailed = true;
      await config.saveNative?.(JSON.stringify({ command: [config.agent].concat(args), error: String(error), at: new Date().toISOString() }) + "\n");
      throw new Error(`T3 device command failed: ${String(error)}`);
    }
  }
  async function evaluate<T>(source: string): Promise<T> {
    return await request(role + "/execute", { source, timeoutMs: config.timeoutMs }) as T;
  }
  async function ready(selected: "host" | "preview"): Promise<Record<string, unknown>> {
    return until(async () => object(await request(selected + "/state") ?? {}), row => typeof row.timeOrigin === "number" && row.visible === true, config.timeoutMs);
  }
  async function present(url: string | null): Promise<void> {
    role = "host";
    await evaluate(`(${presentIphonePreview.toString()})(${JSON.stringify(url)})`);
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
    },
    evaluate,
    async openPreview(url) {
      await request("preview/configure", { url });
      await present(url);
      await ready("preview"); role = "preview";
    },
    async useHost() { role = "host"; },
    async usePreview() { role = "preview"; },
    async closePreview() { await present(null); },
    async nativeClick(button, clicked, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const before = object(await evaluate(`(${armIphoneClick.toString()})(${JSON.stringify(button)},${JSON.stringify(clicked)})`));
      if (typeof before.label !== "string" || typeof before.before !== "string") throw new Error("Missing native click target");
      const snapshot = await device(["snapshot", "-i"], Math.max(1, deadline - Date.now()));
      const ref = nativeButtonRef(snapshot, before.label);
      await device(["press", ref], Math.max(1, deadline - Date.now()));
      const expression = `(() => { const s = globalThis.__goalsIphoneClick, key = globalThis.__goalsIphoneDocument; return { trusted: s?.trusted === true, sameTarget: s?.target === document.querySelector(${JSON.stringify(button)}), timeOrigin: key?.timeOrigin, nonce: key?.nonce, url: location.href, after: document.querySelector(${JSON.stringify(clicked)})?.textContent?.trim() ?? '' }; })()`;
      const expected = before.before.replace(/\b0\b/, "1");
      const after = await until(() => evaluate<Record<string, unknown>>(expression), value => value.trusted === true && value.sameTarget === true && value.url === before.url && value.timeOrigin === before.timeOrigin && value.nonce === before.nonce && value.after === expected, Math.max(1, deadline - Date.now()));
      return { before: before.before, after: after.after, trusted: true, nativeRef: ref, inputMethod: "T3 device_open XCTest" };
    },
    async close() {
      if (deviceFailed) throw new Error("T3 device command failed; stopping device interactions, task tab cleanup is unproved");
      if (!opened) return;
      role = "host";
      const title = await evaluate<string>("document.title");
      // Safari's tab grid exposes each tab title followed by its own Close button.
      await device(["press", 'label="More" role=button'], 5000);
      await device(["press", 'label="All Tabs"'], 5000);
      const snapshot = await device(["snapshot", "-i"], 5000);
      const lines = snapshot.split("\n");
      const index = lines.findIndex(line => line.includes(`[button] ${JSON.stringify(title)}`));
      const close = index >= 0 ? /^(@e\d+(?:~s\d+)?) \[button\] "Close"/.exec(lines[index + 1] ?? "")?.[1] : undefined;
      if (!close) throw new Error("Cannot identify the task's Safari tab for cleanup");
      await device(["press", close], 5000);
      opened = false;
    },
  };
}
