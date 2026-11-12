import type { Browser } from "./catalog";
import type { Cell } from "./model";
export interface PlatformBlocker { reason: string; discovery: { failedBox: string; error: string } }
export function nativePlatformBlocker(cell: Cell): PlatformBlocker | undefined {
  if (cell.browser !== "safari" && cell.browser !== "iphone-safari") return undefined;
  if (cell.status !== "fail" || cell.phase !== "startup") return undefined;
  const prerequisite = /session not created|Could not create a session|Expected (?:native Safari|desktop Safari|iPhone simulator Safari)/.test(cell.error);
  if (!prerequisite) return undefined;
  return { reason: `Native browser prerequisite failed: ${cell.error}`, discovery: { failedBox: `${cell.framework}/${cell.browser}/${cell.engine}`, error: cell.error } };
}
export function blockedCell(cell: Cell, blockers: ReadonlyMap<Browser, PlatformBlocker>): Cell | undefined {
  const blocker = blockers.get(cell.browser);
  if (!blocker || cell.attempts.length) return undefined;
  return { framework: cell.framework, browser: cell.browser, engine: cell.engine, attempts: [], status: "not runnable yet", ...blocker };
}
