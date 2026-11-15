import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { chromium, firefox, webkit } from "playwright";
import { verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

async function checkRejections(page: Page, extension: string): Promise<void> {
  await writeFile(page, `/home/user/entry.${extension}`, 'import("./failure.mjs");');
  const ignored = await run(page, `bun run entry.${extension}`, 10000);
  expect(ignored.code, ignored.output).toBe(1);
  expect(ignored.output).toContain("dynamic-import-startup-marker");
  await writeFile(page, `/home/user/entry.${extension}`, 'import("./failure.mjs").catch(error => console.log("caught", error.message));');
  const caught = await run(page, `bun run entry.${extension}`, 10000);
  expect(caught.code, caught.output).toBe(0);
  expect(caught.output).toBe("caught dynamic-import-startup-marker");
}

async function checkAggregateStartup(page: Page): Promise<void> {
  await writeFile(page, "/home/user/package.json", JSON.stringify({ scripts: { dev: "bun entry.mjs", postdev: "echo unexpected-postdev" } }));
  await writeFile(page, "/home/user/entry.mjs", 'import("./failure.mjs");');
  const cases = [
    { source: 'throw new AggregateError([], "aggregate-startup-marker");', message: "aggregate-startup-marker" },
    { source: 'await Bun.build({ entrypoints: ["./startup-missing-entry.ts"] });', message: "startup-missing-entry.ts" },
  ];
  for (const control of cases) {
    await writeFile(page, "/home/user/failure.mjs", control.source);
    const failed = await run(page, "bun run dev", 60000);
    expect(failed.code, failed.output).toBe(1);
    expect(failed.output).toContain(control.message);
    expect(failed.output).toContain('script "dev" exited with code 1');
    expect(failed.output.indexOf(control.message)).toBeLessThan(failed.output.indexOf("Bun v"));
    expect(failed.output.indexOf("Bun v")).toBeLessThan(failed.output.indexOf('script "dev" exited'));
    expect(failed.output).not.toContain("unexpected-postdev");
  }
  await writeFile(page, "/home/user/entry.mjs", 'import("./failure.mjs").catch(error => console.log("caught", error.message));');
  const caught = await run(page, "bun entry.mjs", 60000);
  expect(caught.code, caught.output).toBe(0);
  expect(caught.output).toContain("caught Bundle failed");
  expect(caught.output).toContain("startup-missing-entry.ts");
  expect(caught.output).not.toContain("Bun v");
  await writeFile(page, "/home/user/entry.mjs", 'console.log("startup-recovered");');
  expect(await run(page, "bun entry.mjs", 60000)).toMatchObject({ code: 0, output: "startup-recovered" });
}

const browsers = { chromium, firefox, webkit };
const selected = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
for (const name of selected) {
  const type = Object.entries(browsers).find(([key]) => key === name)?.[1];
  if (!type) throw new Error(`Unknown browser: ${name}`);
  test(`${name} dynamic imports preserve unhandled and caught rejections`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    const root = provided ? join(provided, "site") : resolve(import.meta.dir, "../web/dist");
    const before = provided ? verifySite(provided) : undefined;
    const task = session("bun-wasm-import-rejection-");
    try {
      const [, origin] = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: root, PORT: "0" });
      const browser = await task.launch(type);
      const page = await browser.newPage({ serviceWorkers: "block" });
      await page.goto(`${origin}?engine=browser&prompt=off&mode=memory`);
      expect(await ready(page)).toContain("ready · Browser");
      await writeFile(page, "/home/user/failure.mjs", 'throw new Error("dynamic-import-startup-marker");');
      await checkRejections(page, "mjs");
      await checkRejections(page, "cjs");
      await checkAggregateStartup(page);
    } finally { await task.cleanup(); }
    if (provided && before) expect(verifySite(provided)).toEqual(before);
  }, 180000);
}
