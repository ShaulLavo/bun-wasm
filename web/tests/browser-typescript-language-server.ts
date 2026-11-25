import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Browser, Page } from "playwright";
import { navigateTestPage } from "./navigate-test-page.ts";
import { ready, run, writeFile } from "./playground.mjs";

const fixture = join(import.meta.dir, "../../tests/language-server/typescript");
const guestProject = "/home/user/lsp-typescript";
const serverCommand = "bun lsp-client.ts node_modules/typescript-language-server/lib/cli.mjs --stdio";

export interface LanguageServerRun {
  typescript: { version: string; source: string } | null;
  initializeMs: number;
  firstDiagnosticsMs: number;
  fixDiagnosticsMs: number;
  warmMedianMs: { hover: number; completion: number; definition: number };
  answers: { diagnostic: string; hover: string; completion: string[]; definition: string; packageDefinition: string };
  commandMs: number;
}

export interface LanguageServerReport {
  installMs: number;
  cold: LanguageServerRun;
  afterReload: LanguageServerRun;
  /** Chromium process tree RSS: after install, peak of the first server run, peak of both runs. */
  memory: { baselineRssMiB: number; coldPeakRssMiB: number; peakRssMiB: number } | null;
}

function projectFiles(): Array<[string, string]> {
  const files: Array<[string, string]> = [[`${guestProject}/lsp-client.ts`, readFileSync(join(fixture, "lsp-client.ts"), "utf8")]];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push([`${guestProject}/${relative(join(fixture, "project"), path)}`, readFileSync(path, "utf8")]);
    }
  };
  walk(join(fixture, "project"));
  return files;
}

async function command(page: Page, text: string, timeout: number): Promise<{ output: string; ms: number }> {
  const result = await run(page, text, timeout);
  if (result.code !== 0) throw new Error(`${text} exited ${result.code}:\n${result.output}`);
  return { output: result.output, ms: result.ms };
}

async function serve(page: Page): Promise<LanguageServerRun> {
  await command(page, `cd ${guestProject}`, 30_000);
  const { output, ms } = await command(page, serverCommand, 600_000);
  const line = output.split("\n").find(text => text.startsWith("LSP_RESULT "));
  if (!line) throw new Error(`no LSP_RESULT line:\n${output}`);
  return { ...(JSON.parse(line.slice("LSP_RESULT ".length)) as Omit<LanguageServerRun, "commandMs">), commandMs: Math.round(ms) };
}

async function open(page: Page, url: string): Promise<void> {
  await navigateTestPage(page, `${url}?engine=browser&prompt=off`);
  const status = await ready(page);
  if (!status.includes("ready")) throw new Error(`playground did not start: ${status}`);
}

/** Linux only: resident memory of the Chromium process tree whose command line carries `marker`. */
export function rssSampler(marker: string): { sample(): void; restart(): number; readonly peakMiB: number } | null {
  if (process.platform !== "linux") return null;
  let peak = 0;
  const total = () => {
    const parents = new Map<number, number>();
    const rss = new Map<number, number>();
    let root = -1;
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid)) continue;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        parents.set(pid, Number(/PPid:\s+(\d+)/.exec(status)?.[1]));
        rss.set(pid, Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0));
        if (root < 0 && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)) root = pid;
      } catch { /* the process exited while listing */ }
    }
    const tree = new Set([root]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, parent] of parents) if (!tree.has(pid) && tree.has(parent)) { tree.add(pid); grew = true; }
    }
    return root < 0 ? 0 : Array.from(tree, pid => rss.get(pid) ?? 0).reduce((sum, kib) => sum + kib, 0) / 1024;
  };
  return {
    sample() { peak = Math.max(peak, total()); },
    restart() { peak = total(); return peak; },
    get peakMiB() { return peak; },
  };
}

/** Installs the fixture with the guest's `bun install`, then drives typescript-language-server before and after a reload. */
export async function typescriptLanguageServerScenario(browser: Browser, url: string, marker?: string): Promise<LanguageServerReport> {
  const context = await browser.newContext();
  const memory = marker ? rssSampler(marker) : null;
  const timer = memory ? setInterval(() => memory.sample(), 250) : undefined;
  const logs: string[] = [];
  try {
    const page = await context.newPage();
    page.on("console", message => logs.push(`[${message.type()}] ${message.text()}`));
    page.on("pageerror", error => logs.push(`[pageerror] ${error.message}`));
    await open(page, url);
    for (const [path, text] of projectFiles()) await writeFile(page, path, text);
    await command(page, `cd ${guestProject}`, 30_000);
    const install = await command(page, "bun install", 300_000);
    const baselineRssMiB = memory?.restart() ?? 0;
    const cold = await serve(page);
    const coldPeakRssMiB = memory?.peakMiB ?? 0;
    await page.reload();
    const status = await ready(page);
    if (!status.includes("ready")) throw new Error(`playground did not restart: ${status}`);
    const afterReload = await serve(page);
    return {
      installMs: Math.round(install.ms),
      cold,
      afterReload,
      memory: memory ? { baselineRssMiB: Math.round(baselineRssMiB), coldPeakRssMiB: Math.round(coldPeakRssMiB), peakRssMiB: Math.round(memory.peakMiB) } : null,
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\npage log:\n${logs.slice(-80).join("\n")}`, { cause: error });
  } finally {
    clearInterval(timer);
    await context.close();
  }
}
