import { firstVisit } from "./first-visit.mjs";
import { playwright, ready, session } from "./playground.mjs";
import { checkWebWorkers } from "./browser-workers.ts";

const s = session("bun-wasm-global-web-workers-");
const failures: string[] = [];
async function checkEngine(browser: Browser, url: string, engine: string, label: string) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const visit = await firstVisit(context, `${url}?engine=${engine}`);
  try {
    const page = await context.newPage();
    await page.goto(visit.url);
    await ready(page);
    await checkWebWorkers(page, label);
  } finally {
    await visit.close();
    await context.close();
  }
}

async function checkBrowser(browserName: string, url: string) {
  if (browserName !== "chromium" && browserName !== "webkit") throw new Error(`Unknown browser ${browserName}`);
  const browser = await s.launch(playwright[browserName]);
  try {
    for (const engine of ["quickjs", "jsc", "browser"]) {
      const label = `${browserName} ${engine}`;
      await checkEngine(browser, url, engine, label).catch(error => {
        failures.push(label);
        console.error(label, error);
      });
    }
  } finally {
    await browser.close();
  }
}

try {
  const url = await s.serve();
  for (const browserName of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"]) {
    await checkBrowser(browserName, url);
  }
} finally {
  await s.cleanup();
}
if (failures.length) throw new Error(`Global Web Worker checks failed for ${failures.join(", ")}`);
import type { Browser } from "playwright";
