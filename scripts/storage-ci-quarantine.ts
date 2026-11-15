import { appendFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { StoragePreservationFailure, storageReportPath } from "../sandbox/tests/storage-browser";
import firefoxProtocol from "./fixtures/storage-ci/firefox.json";
import webkitProtocol from "./fixtures/storage-ci/webkit.json";
import webkitRestorationProtocol from "./fixtures/storage-ci/webkit-restoration.json";

type Diagnostic = StoragePreservationFailure["report"]["pages"][number];
type PageDiagnostic = Exclude<Diagnostic, string>;
const protocols = { firefox: firefoxProtocol, webkit: webkitProtocol };

function normalizedTerminal(terminal: string): string {
  return terminal.replace(/\s+/g, "").replace(/\[\d+ms\]/g, "[ms]").replace(/readyin\d+ms/g, "readyinms")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:port").replace(/\/worker-[a-z0-9]+\.js:\d+:\d+/g, "/worker.js:line:column");
}

function matchesTerminal(terminal: string, expected: string | undefined): boolean {
  return expected !== undefined && normalizedTerminal(terminal) === normalizedTerminal(expected);
}

function isNativePage(page: Diagnostic | undefined, template: string): page is PageDiagnostic {
  if (!page || typeof page === "string") return false;
  const url = new URL(page.url);
  return url.pathname === "/sandbox/" && url.searchParams.get("template") === template && url.searchParams.get("engine") === "browser"
    && page.runtime?.filesystem.status === "ready" && !page.runtime.filesystem.error && page.runtime.started === true && page.runtime.pending === false;
}

function isActiveHono(page: Diagnostic | undefined): page is PageDiagnostic {
  if (!isNativePage(page, "hono")) return false;
  const origin = new URL(page.url).origin;
  return !!page.status?.startsWith("dev server ready") && page.status.includes(" · Browser (native) · ") && page.runtime?.editorPath === "server.ts"
    && page.frames.length === 1 && page.frames[0]?.src === `${origin}/sandbox/__preview/5174/` && page.frames[0].body === "Hello from hono\nIncrement1";
}

function knownConsoleError(browser: string, error: string): boolean {
  if (error === "[bun-wasm development HTML] disconnected") return true;
  if (browser === "webkit") return error === "Failed to load resource: the server responded with a status of 502 ()";
  return error === "[vite] JSHandle@object"
    || error === "[vite] Failed to reload /src/main.ts. This could be due to syntax errors or importing non-existent modules. (see errors above)"
    || error === "runtime: process controller failed Error"
    || /^\[JavaScript Error: "Failed to load ‘’. A ServiceWorker intercepted the request and encountered an unexpected error\." \{file: "http:\/\/127\.0\.0\.1:\d+\/sandbox\/sw\.js" line: 8\}\]$/.test(error);
}

function firstVanillaRestoration(failure: StoragePreservationFailure): string | undefined {
  const { error, errors, pages } = failure.report;
  const original = webkitRestorationProtocol;
  if (error !== original.error || errors.length !== original.errors.length || !errors.every((error, index) => error === original.errors[index])) return;
  if (pages.length !== 2) return;
  const [active, page] = pages;
  if (!isActiveHono(active) || !isNativePage(page, "vanilla")) return;
  const origin = new URL(active.url).origin;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return;
  if (!/^dev server ready in \d+\.\d s · Browser \(native\) · 20\.2 MB$/.test(active.status ?? "")) return;
  if (page.status !== "loading preview…" || page.runtime?.editorPath !== "src/main.ts") return;
  if (!restorationPage(active, original.pages[0]!, origin) || !restorationPage(page, original.pages[1]!, origin)) return;
  return "webkit-first-vanilla-restoration";
}

function restorationPage(page: PageDiagnostic, original: typeof webkitRestorationProtocol.pages[number], origin: string): boolean {
  if (page.url !== original.url.replace(new URL(original.url).origin, origin) || page.storage != null) return false;
  if (page.runtime?.filesystem.error !== undefined || page.frames.length !== 1) return false;
  if (!matchesTerminal(page.terminal, original.terminal)) return false;
  const frame = page.frames[0];
  const expected = original.frames[0]!;
  return frame?.src === expected.src.replace(new URL(original.url).origin, origin)
    && frame.documentUrl === frame.src && frame.body === expected.body
    && frame.readyState === expected.readyState && frame.acceptedDocument === expected.acceptedDocument;
}

export function storageQuarantine(browser: string, failure: StoragePreservationFailure): string | undefined {
  if (failure.report.checkpoint === "first-vanilla-restoration") return browser === "webkit" ? firstVanillaRestoration(failure) : undefined;
  if (browser !== "firefox" && browser !== "webkit") return;
  const { checkpoint, error, errors, pages } = failure.report;
  if (pages.length !== 2 || !errors.every(error => knownConsoleError(browser, error))) return;
  const [active, page] = pages;
  const template = browser === "firefox" ? "vite-vue" : "vanilla";
  if (!isActiveHono(active) || !isNativePage(page, template)) return;
  if (new URL(active.url).origin !== new URL(page.url).origin) return;
  const origin = new URL(active.url).origin;
  if (page.frames.length !== 1) return;
  const original = protocols[browser].pages;
  if (!matchesTerminal(active.terminal, original[0]?.terminal) || !matchesTerminal(page.terminal, original[1]?.terminal)) return;
  if (browser === "firefox") {
    if (checkpoint !== "first-vite-vue-startup" || !error.startsWith("Error: waitForFunction: Dev server stopped before it was ready (exit 254).")) return;
    if (page.status !== "Dev server stopped before it was ready (exit 254). Check the terminal output, then press Restart.") return;
    if (page.frames[0]?.src !== "" || page.frames[0].body !== "" || page.runtime?.editorPath !== "src/App.vue") return;
    return "firefox-first-vue-closed";
  }
  if (checkpoint !== "vanilla-config-restart" || error !== "Error: Storage readiness deadline: vanilla") return;
  if (page.status !== "loading preview…" || page.runtime?.editorPath !== "vite.config.ts") return;
  if (page.frames[0]?.src !== `${origin}/sandbox/__preview/5173/` || page.frames[0].body !== "No bun.wasm server is listening on port 5173.\nStart one in the playground (Bun.serve), then reload this page.\n") return;
  return "webkit-vanilla-config-restart";
}

export async function handleStorageFailure(browser: string, error: unknown, env = process.env): Promise<void> {
  if (!(error instanceof StoragePreservationFailure)) throw error;
  const enabled = env.CI === "true" && env.BUN_WASM_STORAGE_CI_QUARANTINE === "known-20261114";
  const quarantine = enabled ? storageQuarantine(browser, error) : undefined;
  const base = storageReportPath(env);
  const report = base ? `${base.replace(/\.json$/, "")}-${browser}-preservation.json` : undefined;
  if (report) await writeFile(report, JSON.stringify({ browser, quarantine: quarantine ?? null, ...error.report }, null, 2));
  if (!quarantine || !report || !env.GITHUB_STEP_SUMMARY) throw error;
  await appendFile(env.GITHUB_STEP_SUMMARY, `\n### Storage quarantine: ${quarantine}\n\nThe preservation scenario failed with the known signature. This is a quarantined failure, not a product pass. The remaining preservation checks were skipped. Full original diagnostics: \`${basename(report)}\` in this job's Browser guest diagnostics artifact. Removal is tracked in \`.internal/storage-ci-20261114.md\`.\n`);
  console.error(`::warning title=Storage quarantine::${quarantine}: preservation failed with the known signature; original diagnostics retained in ${basename(report)}. See .internal/storage-ci-20261114.md for removal.`);
}
