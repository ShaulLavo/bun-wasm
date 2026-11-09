import type { Engine } from "../../src/engine-kind.js";

export function engineStackBudgets(stack: string, userAgent: string): Partial<Record<Engine, string>> | null {
  if (/\n\s+at /.test(stack)) return { jsc: "800" };
  const desktopFirefox = /\bFirefox\/\d+/.test(userAgent)
    && /\b(?:Windows NT|Macintosh|X11)\b/.test(userAgent)
    && !/\b(?:Android|Mobile|Tablet)\b/.test(userAgent);
  if (desktopFirefox) return { jsc: "192" };
  return { quickjs: "32", jsc: "192" };
}
