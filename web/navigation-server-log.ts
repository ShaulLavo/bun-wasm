import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const navigationParameter = "__bun_wasm_navigation";

function append(record: unknown) {
  const path = process.env.BUN_WASM_NAVIGATION_LOG;
  if (!path) return;
  try { appendFileSync(path, `${JSON.stringify(record)}\n`); }
  catch (error) { console.error("Navigation host journal failed:", error); }
}

export function navigationServerListening(url: URL) {
  append({ id: null, event: "listening", at: Date.now(), url: String(url), pid: process.pid });
}

export function navigationServerLog(request: Request) {
  const path = process.env.BUN_WASM_NAVIGATION_LOG;
  const id = new URL(request.url).searchParams.get(navigationParameter);
  function record(event: "arrival" | "response-return" | "abort" | "handler-error", detail: unknown = null) {
    if (!path || !id) return;
    append({ id, event, at: Date.now(), url: request.url, detail });
  }
  if (path && id) {
    record("arrival", { method: request.method });
    request.signal.addEventListener("abort", () => record("abort"), { once: true });
  }
  return record;
}

export async function readNavigationServerLog(id: string, url: string) {
  const path = process.env.BUN_WASM_NAVIGATION_LOG;
  if (!path) return { enabled: false };
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") content = "";
    else throw error;
  }
  const records: unknown[] = content.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const events = records.filter(record => hasId(record, id));
  const listening = records.filter(record => hasId(record, null) && "url" in record && record.url === `${new URL(url).origin}/`);
  return { enabled: true, id, listening, events, meaning: "response-return records a constructed Response, not socket delivery" };
}

function hasId(value: unknown, id: string | null): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && "id" in value && value.id === id;
}
