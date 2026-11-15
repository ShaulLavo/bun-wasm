import { checkedProcessCwd } from "waffle/proc/types";

export interface PackagePhase {
  readonly name: string;
  readonly original: string;
  readonly command: string;
}

/** Private, prepared guest data. Bash alone parses command; only main contains quoted arguments. */
export interface PackagePlan {
  readonly version: 1;
  readonly pre: PackagePhase | null;
  readonly main: PackagePhase;
  readonly post: PackagePhase | null;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly silent: boolean;
  readonly color: boolean;
  readonly footer: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected package plan object");
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("Expected NUL-free package plan string");
  return value;
}

function phase(value: unknown): PackagePhase {
  const entry = record(value);
  return Object.freeze({ name: string(entry.name), original: string(entry.original), command: string(entry.command) });
}

function environment(value: unknown): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(record(value))) {
    if (!key || key.includes("=") || key.includes("\0")) throw new TypeError("Invalid package environment key");
    result[key] = string(item);
  }
  return Object.freeze(result);
}

export function parsePackagePlan(value: unknown): PackagePlan {
  const plan = record(value);
  if (plan.version !== 1 || typeof plan.silent !== "boolean" || typeof plan.color !== "boolean") throw new TypeError("Invalid package plan flags");
  const main = phase(plan.main);
  const pre = plan.pre === null ? null : phase(plan.pre);
  const post = plan.post === null ? null : phase(plan.post);
  if (pre && pre.name !== `pre${main.name}` || post && post.name !== `post${main.name}`) throw new TypeError("Invalid package lifecycle order");
  return Object.freeze({ version: 1, pre, main, post, env: environment(plan.env), cwd: checkedProcessCwd(plan.cwd), silent: plan.silent, color: plan.color, footer: string(plan.footer) });
}
