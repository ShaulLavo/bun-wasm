import assert from "node:assert/strict";
import { playwright, ready, session } from "./playground.mjs";
import { checkPlaygroundStdin } from "./playground-stdin";

const task = session("bun-wasm-stdin-");
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(1)); }, 90000);
try {
  const url = await task.serve();
  const browser = await task.launch(playwright.chromium);
  const page = await browser.newPage();
  await page.goto(`${url}?prompt=off&engine=browser`);
  assert.match(await ready(page), /ready/);
  await checkPlaygroundStdin(page);
  console.log("PASS terminal stdin survives env and shebangs, accepts input, and ends only on EOF; pipes retain EOF");
} finally {
  clearTimeout(timer);
  await task.cleanup();
}
