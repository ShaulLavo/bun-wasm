import type { Engine } from "../../src/engine-kind.js";

/** The host families of docs/stack-limits.md. "firefox-desktop" is desktop Firefox off Linux. */
export const stackHosts = ["v8", "firefox-linux", "firefox-desktop", "safari-macos", "other"] as const;
export type StackHostFamily = typeof stackHosts[number];
export type StackHost = { readonly platform?: string; readonly vendor?: string; readonly maxTouchPoints?: number };

/** What only the page can read. A worker has no touch points, and iPadOS Safari sends a Macintosh user agent. */
export type PageFacts = Pick<StackHost, "maxTouchPoints">;

/** Page observations for a run request, or undefined when no navigator is available. */
export function pageFacts(): StackHost | undefined {
  if (!globalThis.navigator) return undefined;
  return { platform: navigator.platform, vendor: navigator.vendor, maxTouchPoints: navigator.maxTouchPoints };
}

/** A parser reserve that passed its own host family's qualification, never another family's. */
interface QualifiedParserReserve { readonly bytes: string; readonly minimumSafariMajor?: number }
export type QualifiedParserReserves = { readonly [Host in StackHostFamily]?: QualifiedParserReserve };

/**
 * BUN_WASM_JSC_PARSER_RESERVE per host family (docs/stack-limits.md). A family without an entry
 * keeps the guest's 2048-byte default: no value is extended from one family to another.
 */
export const qualifiedParserReserves: QualifiedParserReserves = {
  // Firefox 157 on Linux: every recursion path at 208 and 260 KiB, warm and cold (docs/stack-limits.md).
  "firefox-linux": { bytes: "960" },
};

const safariImpostors = /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR|Firefox|Mobile|iPhone|iPad|Android/;

function firefoxHost(userAgent: string): StackHostFamily | undefined {
  if (!/\bFirefox\/\d+/.test(userAgent) || /\b(?:Android|Mobile|Tablet|FxiOS)\b/.test(userAgent)) return undefined;
  if (/\bX11\b/.test(userAgent) && /\bLinux\b/.test(userAgent)) return "firefox-linux";
  return /\b(?:Windows NT|Macintosh|X11)\b/.test(userAgent) ? "firefox-desktop" : undefined;
}

function macSafari(userAgent: string, page: PageFacts | undefined): boolean {
  if (page?.maxTouchPoints !== 0) return false;
  return /\bMacintosh\b/.test(userAgent) && /\bVersion\/\d+/.test(userAgent) && /\bSafari\//.test(userAgent) && !safariImpostors.test(userAgent);
}

export function stackHost(stack: string, userAgent: string, page?: PageFacts): StackHostFamily {
  if (/\n\s+at /.test(stack)) return "v8";
  return firefoxHost(userAgent) ?? (macSafari(userAgent, page) ? "safari-macos" : "other");
}

/** JSC's native recursion budget in KiB for each host family. */
export const jscStackBudgets: Readonly<Record<StackHostFamily, string>> = {
  v8: "800", "firefox-linux": "208", "firefox-desktop": "208", "safari-macos": "192", other: "192",
};

/**
 * SpiderMonkey's byte quota in KiB on WebKit, whose workers get Apple's 512 KiB stack on macOS and
 * iOS. It is the smallest value that still loads Next's webpack hook, so cold statement nesting
 * deeper than about 85 levels still overflows the host first (docs/stack-limits.md).
 */
export const spiderMonkeyWebKitStackKib = "188";

export function engineStackBudgets(stack: string, userAgent: string, host?: StackHost): Partial<Record<Engine, string>> | null {
  if (/\n\s+at /.test(stack)) return { jsc: "800" };
  const firefox = /\bFirefox\/\d+/.test(userAgent);
  const desktopFirefox = firefox
    && /\b(?:Windows NT|Macintosh|X11)\b/.test(userAgent)
    && !/\b(?:Android|Mobile|Tablet)\b/.test(userAgent);
  if (desktopFirefox) return { jsc: "208" };
  // A Macintosh UA also identifies desktop-style iPads. Touch evidence must come from the page.
  const desktopSafari = host?.platform === "MacIntel" && host.vendor === "Apple Computer, Inc." && host.maxTouchPoints === 0
    && /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X [\d_.]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Version\/[\d.]+ Safari\/[\d.]+$/.test(userAgent);
  const budgets = { quickjs: desktopSafari ? "36" : "32", jsc: "192" };
  // Gecko on Android keeps SpiderMonkey's full quota, as desktop Firefox and V8 do.
  return firefox ? budgets : { ...budgets, spidermonkey: spiderMonkeyWebKitStackKib };
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
