import type { Engine } from "../../src/engine-kind";

export function engineStackBudgets(stack: string, _userAgent: string): Partial<Record<Engine, string>> | null {
  if (/\n\s+at /.test(stack)) return null;
  return { quickjs: "32", jsc: "192" };
}
