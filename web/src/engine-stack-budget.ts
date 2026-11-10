import type { Engine } from "../../src/engine-kind.js";

export type StackHost = { readonly platform?: string; readonly vendor?: string; readonly maxTouchPoints?: number };

export function engineStackBudgets(stack: string, userAgent: string, host?: StackHost): Partial<Record<Engine, string>> | null {
  if (/\n\s+at /.test(stack)) return { jsc: "800" };
  const desktopFirefox = /\bFirefox\/\d+/.test(userAgent)
    && /\b(?:Windows NT|Macintosh|X11)\b/.test(userAgent)
    && !/\b(?:Android|Mobile|Tablet)\b/.test(userAgent);
  if (desktopFirefox) return { jsc: "208" };
  // A Macintosh UA also identifies desktop-style iPads. Touch evidence must come from the page.
  const desktopSafari = host?.platform === "MacIntel" && host.vendor === "Apple Computer, Inc." && host.maxTouchPoints === 0
    && /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X [\d_.]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Version\/[\d.]+ Safari\/[\d.]+$/.test(userAgent);
  return { quickjs: desktopSafari ? "36" : "32", jsc: "192" };
}
