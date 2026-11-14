import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { fits } from "../web/tests/phone-ui.mjs";

let browser: Browser;
let page: Page;
const markup = `<header><h1>Title</h1><a class="nav">Vite</a><a class="nav">Next</a><a class="nav">Sandbox</a></header>
  <select id="engine"><option>JSC</option></select><button id="run">Run</button><button id="copy-terminal">Copy</button>`;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 320, height: 850 } });
}, 30000);
afterAll(async () => { await browser?.close(); });

test("checks every phone control", async () => {
  await page.setContent(markup);
  await fits(page, "valid");
  await page.locator("header a.nav").last().evaluate(element => {
    element.style.position = "fixed";
    element.style.left = "400px";
  });
  await assert.rejects(fits(page, "overflow"), /header a\.nav outside viewport/);
}, 30000);

test("requires each control group", async () => {
  for (const selector of ["header h1", "header a.nav", "#engine", "#run", "#copy-terminal"]) {
    await page.setContent(markup);
    await page.locator(selector).evaluateAll(elements => elements.forEach(element => element.remove()));
    await assert.rejects(fits(page, "missing"), new RegExp(RegExp.escape(selector)));
  }
}, 30000);
