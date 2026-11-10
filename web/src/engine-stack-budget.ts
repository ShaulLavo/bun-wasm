import type { Engine } from "../../src/engine-kind.js";

/** The host families of docs/stack-limits.md. "firefox-desktop" is desktop Firefox off Linux. */
export const stackHosts = ["v8", "firefox-linux", "firefox-desktop", "safari-macos", "other"] as const;
export type StackHost = typeof stackHosts[number];

/** What only the page can read. A worker has no touch points, and iPadOS Safari sends a Macintosh user agent. */
export interface PageFacts { readonly maxTouchPoints: number }

/** The page's facts for a run request, or undefined where there are none to read, as in a worker. */
export function pageFacts(): PageFacts | undefined {
  const maxTouchPoints: unknown = globalThis.navigator?.maxTouchPoints;
  return typeof maxTouchPoints === "number" ? { maxTouchPoints } : undefined;
}

/** A parser reserve that passed its own host family's qualification, never another family's. */
interface QualifiedParserReserve { readonly bytes: string; readonly minimumSafariMajor?: number }
export type QualifiedParserReserves = { readonly [Host in StackHost]?: QualifiedParserReserve };

/**
 * BUN_WASM_JSC_PARSER_RESERVE per host family (docs/stack-limits.md). A family without an entry
 * keeps the guest's 2048-byte default: no value is extended from one family to another.
 */
export const qualifiedParserReserves: QualifiedParserReserves = {
  // Firefox 157 on Linux: every recursion path at 208 and 260 KiB, warm and cold (docs/stack-limits.md).
  "firefox-linux": { bytes: "960" },
};

const safariImpostors = /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR|Firefox|Mobile|iPhone|iPad|Android/;

function firefoxHost(userAgent: string): StackHost | undefined {
  if (!/\bFirefox\/\d+/.test(userAgent) || /\b(?:Android|Mobile|Tablet|FxiOS)\b/.test(userAgent)) return undefined;
  if (/\bX11\b/.test(userAgent) && /\bLinux\b/.test(userAgent)) return "firefox-linux";
  return /\b(?:Windows NT|Macintosh|X11)\b/.test(userAgent) ? "firefox-desktop" : undefined;
}

function macSafari(userAgent: string, page: PageFacts | undefined): boolean {
  if (page?.maxTouchPoints !== 0) return false;
  return /\bMacintosh\b/.test(userAgent) && /\bVersion\/\d+/.test(userAgent) && /\bSafari\//.test(userAgent) && !safariImpostors.test(userAgent);
}

export function stackHost(stack: string, userAgent: string, page?: PageFacts): StackHost {
  if (/\n\s+at /.test(stack)) return "v8";
  return firefoxHost(userAgent) ?? (macSafari(userAgent, page) ? "safari-macos" : "other");
}

/** JSC's native recursion budget in KiB for each host family. */
export const jscStackBudgets: Readonly<Record<StackHost, string>> = {
  v8: "800", "firefox-linux": "208", "firefox-desktop": "208", "safari-macos": "192", other: "192",
};

export function engineStackBudgets(stack: string, userAgent: string): Partial<Record<Engine, string>> | null {
  const host = stackHost(stack, userAgent);
  const jsc = jscStackBudgets[host];
  return host === "safari-macos" || host === "other" ? { quickjs: "32", jsc } : { jsc };
}

/** The qualified parser reserve for this host, or undefined to keep the guest's default. */
export function jscParserReserve(stack: string, userAgent: string, page?: PageFacts, qualified: QualifiedParserReserves = qualifiedParserReserves): string | undefined {
  const entry = qualified[stackHost(stack, userAgent, page)];
  if (!entry) return undefined;
  if (entry.minimumSafariMajor === undefined) return entry.bytes;
  const major = Number(/\bVersion\/(\d+)/.exec(userAgent)?.[1]);
  return major >= entry.minimumSafariMajor ? entry.bytes : undefined;
}

/**
 * The reserve a JSC guest uses for a BUN_WASM_JSC_PARSER_RESERVE value, mirroring the guest's own
 * rule (crates/bunwasm-jsc/cpp/helpers.cpp): a whole string of one to four decimal digits from 512
 * through 2048, rounded up to a multiple of 16. Anything else keeps 2048 and is never clamped.
 */
export function effectiveParserReserve(value: string | undefined): number {
  if (value === undefined || !/^[0-9]{1,4}$/.test(value)) return 2048;
  const bytes = Number(value);
  return bytes < 512 || bytes > 2048 ? 2048 : Math.ceil(bytes / 16) * 16;
}
