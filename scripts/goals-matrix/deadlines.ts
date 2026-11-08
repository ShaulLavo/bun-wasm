import { frameworks } from "./catalog";
import { object } from "./evidence";

export const cleanupTimeoutMs = 20_000;
export interface DeadlinePolicy {
  timeoutMs: number;
  installTimeouts: Record<string, number>;
  buildTimeouts: Record<string, number>;
  cleanupTimeoutMs: typeof cleanupTimeoutMs;
}
export function parseTimeout(value: string, option = "timeout-ms"): number {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) throw new Error(`${option} must be an integer from 100 through 900000`);
  return timeoutMs;
}
export function parseInstallTimeouts(value: string | undefined): Record<string, number> {
  if (value === undefined) return {};
  const entries = new Map<string, number>();
  for (const entry of value.split(",")) {
    const [name, duration, extra] = entry.split(":");
    const framework = frameworks.find(item => item.id === name)?.id;
    if (!framework || duration === undefined || !/^\d+$/.test(duration) || extra !== undefined) throw new Error(`Expected install-timeout-ms=framework:milliseconds, received ${entry}`);
    if (entries.has(framework)) throw new Error(`Repeated install timeout for ${framework}`);
    entries.set(framework, parseTimeout(duration, "install-timeout-ms"));
  }
  return Object.fromEntries(entries);
}
export function deadlinePolicy(timeoutMs: number, overrides: Readonly<Record<string, number>> = {}): DeadlinePolicy {
  return { timeoutMs, installTimeouts: Object.fromEntries(frameworks.map(framework => [framework.id, overrides[framework.id] ?? timeoutMs])),
    buildTimeouts: Object.fromEntries(frameworks.map(framework => [framework.id, framework.id === "next" ? Math.max(timeoutMs, 110_000) : timeoutMs])), cleanupTimeoutMs };
}
export function validateDeadlines(value: unknown): DeadlinePolicy {
  const data = object(value), installs = object(data.installTimeouts);
  if (typeof data.timeoutMs !== "number" || data.cleanupTimeoutMs !== cleanupTimeoutMs) throw new Error("Invalid deadline policy");
  parseTimeout(String(data.timeoutMs));
  if (Object.keys(installs).length !== frameworks.length) throw new Error("Deadline policy must include every framework install");
  const normalized: Record<string, number> = {};
  for (const framework of frameworks) {
    const timeout = installs[framework.id];
    if (typeof timeout !== "number") throw new Error(`Missing install deadline for ${framework.id}`);
    normalized[framework.id] = parseTimeout(String(timeout));
  }
  const policy = deadlinePolicy(data.timeoutMs, normalized);
  const builds = object(data.buildTimeouts);
  if (Object.keys(builds).length !== frameworks.length || frameworks.some(framework => builds[framework.id] !== policy.buildTimeouts[framework.id])) throw new Error("Invalid framework build deadline policy");
  return policy;
}
export function sameDeadlines(first: DeadlinePolicy, second: DeadlinePolicy): boolean {
  return first.timeoutMs === second.timeoutMs && first.cleanupTimeoutMs === second.cleanupTimeoutMs && frameworks.every(framework => first.installTimeouts[framework.id] === second.installTimeouts[framework.id] && first.buildTimeouts[framework.id] === second.buildTimeouts[framework.id]);
}
