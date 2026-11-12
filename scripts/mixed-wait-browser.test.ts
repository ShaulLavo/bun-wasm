import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

test("real QuickJS and JSC browser guests complete mixed waits; Browser keeps normal completion", async () => {
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (!provided) throw new Error("Supply the same-commit CI guest site; this check never rebuilds a guest");
  const site = resolve(provided), before = verifySite(site);
  const name = process.env.BUN_WASM_TEST_BROWSERS ?? "chromium";
  if (name !== "chromium" && name !== "webkit") throw new Error("Select chromium or webkit");
  const task = session("bun-wasm-mixed-guest-");
  const previous = process.env.ROOT;
  process.env.ROOT = join(site, "site");
  try {
    const browser = await task.launch(name === "chromium" ? chromium : webkit), url = await task.serve();
    const engines = ["quickjs", "browser"];
    if (process.env.BUN_WASM_JSC_PRODUCER !== "unselected") engines.push("jsc");
    const source = readFileSync(new URL("../tests/fixtures/mixed-io-wait/index.ts", import.meta.url), "utf8");
    for (const engine of engines) await exercise(engine);
    expect(verifySite(site)).toEqual(before);

    async function exercise(engine: string) {
      const transports = name === "chromium" && engine !== "browser" ? ["imports", "table"] : ["imports"];
      for (const slots of transports) {
        const page = await browser.newPage();
        try {
          await page.goto(`${url}?engine=${engine}&slots=${slots}&prompt=off&mode=memory`);
          expect(await ready(page)).toContain("ready");
          await writeFile(page, "/home/user/mixed-io.ts", source);
          const result = await run(page, "bun run mixed-io.ts", 30000);
          expect(result.code, `${engine}/${slots}: ${result.output}`).toBe(0);
          expect(result.output).toContain("mixed socket and selected child pipe: four replies, child exit");
        } finally { await page.close(); }
      }
    }
  } finally { await task.cleanup(); if (previous === undefined) delete process.env.ROOT; else process.env.ROOT = previous; }
}, 240000);
