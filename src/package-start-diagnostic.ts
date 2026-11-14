import type { ProcessExit } from "waffle/proc/types";

// Waffle .130 proc/start-errno.ts and proc/start-diagnostic.ts, restricted to a
// synchronous ProcessError reservation failure. No original Error crosses a worker.
const failures = { ENOENT: 44, EACCES: 2, ENOTDIR: 54, ELOOP: 32, ENOEXEC: 45, ENOMEM: 48, EAGAIN: 6, EIO: 29 } satisfies Record<Extract<ProcessExit, { kind: "start-failed" }>["error"], number>;
export function startFailureErrno(error: keyof typeof failures): number { return failures[error]; }

function property(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try { return Reflect.get(value, key); }
  catch { return undefined; }
}
function prefix(value: string, limit: number): string {
  return value.slice(0, limit) + (value.length > limit ? " [truncated]" : "");
}
function scalar(value: unknown, limit: number): string | undefined {
  if (typeof value === "string") return prefix(value, limit);
  if (value === null || typeof value !== "object" && typeof value !== "function") return prefix(String(value), limit);
  return undefined;
}
function errorLine(error: unknown): string {
  const name = property(error, "name"), message = property(error, "message");
  const code = property(error, "code"), errno = property(error, "errno");
  const label = typeof name === "string" ? prefix(name, 80) : "Thrown value";
  const text = typeof message === "string" ? prefix(message, 256) : scalar(error, 256);
  let line = `${label}: ${text ?? "[object]"}`;
  if (code !== undefined) line += ` [code=${scalar(code, 80) ?? "[object]"}]`;
  if (errno !== undefined) line += ` [errno=${scalar(errno, 32) ?? "[object]"}]`;
  return line;
}
export function describeStartError(error: unknown): string {
  let text = "", current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) return `${text}\nCaused by: [circular cause]`;
    seen.add(current);
    text += `${depth ? "\nCaused by: " : ""}${errorLine(current)}`;
    const cause = property(current, "cause");
    if (cause === undefined) break;
    current = cause;
    if (depth === 7) text += "\n[cause depth limit]";
  }
  const stack = property(error, "stack");
  if (typeof stack === "string") text += `\n${prefix(stack, 512)}`;
  return text;
}
export function diagnosticBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(4096);
  const { written } = new TextEncoder().encodeInto(text, bytes);
  return bytes.subarray(0, written);
}
export function diagnosticText(bytes: Uint8Array): string { return new TextDecoder().decode(bytes); }
