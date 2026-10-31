import type { BrowserContext, Page } from "playwright";
export function firstVisit(context: BrowserContext, base: string, options?: { delayActivation?: boolean }): Promise<{
  url: string;
  diagnostics(): { mode: string; pending: string[] };
  check(page: Page, moduleScope?: boolean): Promise<void>;
  close(): Promise<void>;
}>;
