import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
export const web: string;
export const playwright: typeof import("playwright");
export function session(prefix: string): {
  scratch: string;
  cleanup(): Promise<void>;
  start(args: string[], pattern: RegExp, env?: NodeJS.ProcessEnv): Promise<RegExpExecArray>;
  serve(): Promise<string>;
  fixture(): Promise<string>;
  launch(type: BrowserType): Promise<Browser>;
  launch<T extends Browser | BrowserContext>(type: { launch(): Promise<T> }): Promise<T>;
};
export function ready(page: Page, milliseconds?: number): Promise<string>;
export function terminalText(page: Page): Promise<string>;
export function writeFile(page: Page, path: string, text: string): Promise<void>;
export function run(page: Page, command: string, milliseconds?: number): Promise<{ code: number | null; output: string; ms: number }>;
