import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { accumulation } from "../sandbox/tests/storage-browser";
import { SOURCE_LIMIT_BYTES } from "../sandbox/src/workspace-source";

async function contextFor(control: boolean, scratch: string) {
  if (!control) {
    const context = await chromium.launchPersistentContext(scratch, { headless: true });
    return { context, close: () => context.close() };
  }
  const browser = await chromium.launch({ headless: true });
  try { return { context: await browser.newContext(), close: () => browser.close() }; }
  catch (error) { await browser.close(); throw error; }
}

const [mode, url, output, quotaArgument] = process.argv.slice(2);
if ((mode !== "control" && mode !== "measure") || !url || !output) throw new Error("Usage: sandbox-storage-measure.ts control|measure <sandbox-url> <report.json> [quota-bytes]");
const quotaSize = Number(quotaArgument ?? 240 * 1024 * 1024);
const scratch = await mkdtemp("/work/tmp/bun-wasm-storage-measure-");
try {
  const { context, close } = await contextFor(mode === "control", scratch);
  try {
    const page = await context.newPage();
    await page.goto(new URL("engine-builds.json", url).href);
    const builds = await page.textContent("body");
    const cdp = await context.newCDPSession(page);
    if (mode === "control") await cdp.send("Storage.overrideQuotaForOrigin", { origin: new URL(url).origin, quotaSize });
    const sequence = mode === "control" ? ["vanilla", "vite-react", "vite-vue", "vite-svelte"] : ["vanilla", "vite-react", "next", "nuxt", "sveltekit", "astro", "angular", "tanstack-start", "next"];
    const rows = await accumulation(context, url, sequence);
    await Bun.write(output, JSON.stringify({ mode, url, quotaSize: mode === "control" ? quotaSize : null, browser: context.browser()?.version(), builds, rows, timings: "PC shared load; elapsed includes startup and explicit successful checkpoint. The final Next entry is the warm reinstall." }, null, 2));
    assert.equal(rows[0]?.error, undefined, "cap does not admit a single installed project");
    if (mode === "control") {
      assert.ok((rows[0]?.storage.usage ?? Infinity) + SOURCE_LIMIT_BYTES < quotaSize, "cap leaves no payload headroom after one install");
      assert.ok(rows.some(row => row.error), "old-code accumulation control did not fail at recorded cap");
    }
    else assert.ok(rows.length === sequence.length && rows.every(row => !row.error), "post-feature storage measurement failed");
  } finally { await close(); }
} finally { await rm(scratch, { recursive: true, force: true }); }
