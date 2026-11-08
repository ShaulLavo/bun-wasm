import { createContext, runInContext } from "node:vm";
import type { Framework } from "./catalog";
import type { Transport } from "./transport";
import { phases, type Attempt, type Phase } from "./model";
function evidence(phase: Phase): unknown {
  switch (phase) {
    case "startup": return { ready: true, status: "ready", engine: "browser", agent: "fixture" };
    case "install": case "build": return { done: true, code: 0, error: null, output: "fixture" };
    case "dev": return { url: "http://fixture/" };
    case "render": return { matched: true, text: "fixture" };
    case "click": return { before: "count 0", after: "count 1" };
    case "hot-reload": return { updated: "updated", before: "count 1", sameDocument: true, manualNavigations: 0, result: { matched: true, text: "updated" } };
    case "preview": return { rendered: { matched: true, text: "updated" }, clicked: { before: "0", after: "1" } };
    case "cleanup": return { browserClosed: true, foregroundStopped: true, previewClosed: true };
    default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
}
export function completeAttempt(): Attempt {
  return { startedAt: "now", finishedAt: "now", browser: { browserName: "chrome" }, phases: phases.map(phase => ({ phase, status: "pass", evidence: evidence(phase), startedAt: "now", durationMs: 1, timeoutMs: phase === "cleanup" ? 20_000 : 180_000 })) };
}

export async function withPlayground<T>(framework: Framework, installDelayMs: number, action: (transport: Transport) => Promise<T>): Promise<T> {
  const pending: Promise<void>[] = [];
  let listening = false, count = 0, message = framework.text;
  const shell = { running: false, lastExit: 0,
    async submit(text: string): Promise<void> {
      if (text === "bun install") { const install = Bun.sleep(installDelayMs); pending.push(install); return install; }
      if (text === "bun run build") return;
      shell.running = true; listening = true; count = 0;
      return new Promise(() => {});
    },
    input() { shell.running = false; listening = false; },
  };
  const view = { state: { doc: { toString: () => message, get length() { return message.length; } } },
    dispatch(change: { changes: { insert: string } }) { message = change.changes.insert; },
  };
  const counter = { get textContent() { return `count ${count}`; }, disabled: false, click() { count++; } };
  const context = createContext({ crypto, URL, location: { href: "http://fixture/?engine=browser" }, navigator: { userAgent: "goals-deadline-unit-fixture" },
    document: { querySelector(selector: string) {
      if (selector === "#status") return { textContent: "Browser (native) ready" };
      if (selector === "#engine") return { value: "browser" };
      if (selector === framework.button || selector === framework.clicked) return counter;
      return { textContent: message };
    } },
    playground: { shell, previews: { ready: Promise.resolve("ready"), serves: () => listening, url: () => "http://fixture/preview" },
      editor: { async open() {}, async save() {}, view },
      term: { write(_text: string, callback: () => void) { callback(); }, buffer: { active: { length: 0 } } },
    },
  });
  const transport: Transport = { capabilities: { browserName: "chrome", transport: "unit-fixture" },
    async navigate(url) { context.location.href = url; },
    async evaluate<R>(expression: string): Promise<R> { return runInContext(expression, context); },
    async openPreview() {}, async useHost() {}, async usePreview() {}, async closePreview() {},
    async close() { await Promise.all(pending); },
  };
  try { return await action(transport); }
  finally { await transport.close(); }
}
