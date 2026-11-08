import type { Engine } from "../../src/engine-kind";

export function engineStackBudgets(stack: string, userAgent: string): Partial<Record<Engine, string>> | null {
  if (/\n\s+at /.test(stack)) return null;
  if (/\bFirefox\/\d+/.test(userAgent)) return { jsc: "192" };
  return { quickjs: "32", jsc: "192" };
}
