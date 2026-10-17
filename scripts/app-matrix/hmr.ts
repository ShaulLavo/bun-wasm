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
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    if (typeof payload === "string") messages.push(payload);
  }));
  return async function verify(project: string, selector: string, change: Change, timeout: number) {
    const path = join(project, change.path);
    const original = readFileSync(path, "utf8");
    if (!original.includes(change.search)) throw new Error(`HMR source marker missing in ${change.path}`);
    const firstMessage = messages.length;
    try {
      writeFileSync(path, original.replace(change.search, change.replacement));
      await page.locator(selector).filter({ hasText: change.replacement }).waitFor({ timeout });
      if (!messages.slice(firstMessage).some(message => /"type"\s*:\s*"(?:update|full-reload)"/.test(message))) throw new Error("Source edit rendered without a Vite WebSocket update");
      return `source edit renders ${JSON.stringify(change.replacement)} after a Vite WebSocket update`;
    } finally { writeFileSync(path, original); }
  };
}
