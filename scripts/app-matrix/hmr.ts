import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Page {
  on(event: "websocket", listener: (socket: { on(event: "framereceived", listener: (event: { payload: unknown }) => void): void }) => void): void;
  locator(selector: string): { filter(options: { hasText: string }): { waitFor(options: { timeout: number }): Promise<void> } };
}
interface Change {
  path: string;
  search: string;
  replacement: string;
}

export function observeHmr(page: Page) {
  const messages: string[] = [];
  let connected = false;
  let connectedResolve: (() => void) | null = null;
  const connectedPromise = new Promise<void>(resolve => { connectedResolve = resolve; });
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    if (typeof payload !== "string") return;
    messages.push(payload);
    try {
      connected ||= JSON.parse(payload).type === "connected";
      if (connected) connectedResolve?.();
    } catch { }
  }));
  return async function verify(project: string, selector: string, change: Change, timeout: number, capture?: () => Promise<void>) {
    const path = join(project, change.path);
    const original = readFileSync(path, "utf8");
    if (!original.includes(change.search)) throw new Error(`HMR source marker missing in ${change.path}`);
    const firstMessage = messages.length;
    try {
      if (!connected) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            connectedPromise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Vite HMR WebSocket did not send its connected message")), timeout); }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      writeFileSync(path, original.replace(change.search, change.replacement));
      await page.locator(selector).filter({ hasText: change.replacement }).waitFor({ timeout });
      if (!messages.slice(firstMessage).some(message => /"type"\s*:\s*"(?:update|full-reload)"/.test(message))) throw new Error("Source edit rendered without a Vite WebSocket update");
      await capture?.();
      return `source edit renders ${JSON.stringify(change.replacement)} after a Vite WebSocket update`;
    } finally { writeFileSync(path, original); }
  };
}
