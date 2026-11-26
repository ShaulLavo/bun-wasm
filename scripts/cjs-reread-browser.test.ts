import { expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { withGuestSite } from "./browser-guest-page";
import { ready, run, terminalText, writeFile } from "../web/tests/playground.mjs";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

// Tests here start real browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

// A CommonJS compile may reuse the read of its own format check (modules.rs, load_source_once).
// Each program below lets the page, not the guest, rewrite a CommonJS file after the guest read
// it, then loads it again: the guest must run the file as it is now.
const cases = [
  {
    // Two CommonJS leaves: graph preparation checks both before either runs. The first throws;
    // the retry reuses the graph's format records.
    name: "two-leaf retry",
    file: "cjs-retry/bad.cjs",
    replacement: "module.exports = 'fixed';",
    program: `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("cjs-retry", { recursive: true });
writeFileSync("cjs-retry/bad.cjs", "throw new Error('old-code');");
writeFileSync("cjs-retry/other.cjs", "module.exports = 'other';");
writeFileSync("cjs-retry/graph.mjs", "import bad from './bad.cjs'; import other from './other.cjs'; export default bad + ':' + other;");
try { await import("./cjs-retry/graph.mjs"); throw new Error("old code unexpectedly loaded"); }
catch (error) { console.log("cjs-retry first failed", error.message); }
while (!existsSync("cjs-retry/go")) await new Promise((resolve) => setTimeout(resolve, 20));
console.log("result", (await import("./cjs-retry/graph.mjs")).default);
`,
    expected: "result fixed:other",
  },
  {
    // A graph whose preparation fails after checking a CommonJS leaf; the leaf is then imported
    // on its own.
    name: "failed graph, then the leaf",
    file: "cjs-failed/last.cjs",
    replacement: "module.exports = 'new-leaf';",
    program: `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("cjs-failed", { recursive: true });
writeFileSync("cjs-failed/first.mjs", "import './missing.mjs';");
writeFileSync("cjs-failed/last.cjs", "module.exports = 'old-leaf';");
writeFileSync("cjs-failed/graph.mjs", "import './first.mjs'; import './last.cjs';");
try { await import("./cjs-failed/graph.mjs"); throw new Error("missing import unexpectedly resolved"); }
catch (error) { console.log("cjs-failed first failed", String(error.message).includes("missing.mjs")); }
while (!existsSync("cjs-failed/go")) await new Promise((resolve) => setTimeout(resolve, 20));
console.log("result", (await import("./cjs-failed/last.cjs")).default);
`,
    expected: "result new-leaf",
  },
];

for (const browserName of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${browserName}: a CommonJS file rewritten by the page runs as rewritten`, async () => {
    await withGuestSite(browserName, "bun-wasm-cjs-reread", scenario);
  }, 300000);
}

async function scenario(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await navigateTestPage(page, `${url}?engine=browser&prompt=off`);
    expect(await ready(page)).toContain("ready");
    for (const each of cases) {
      const result = await rewriteDuringRun(page, each);
      expect(result.code, `${each.name}: ${result.output}`).toBe(0);
      expect(result.output, each.name).toContain(each.expected);
    }
  } finally {
    await context.close();
  }
}

/** Runs one case, rewriting its file through the page once the guest reported its first load. */
async function rewriteDuringRun(page: Page, each: (typeof cases)[number]) {
  const dir = each.file.split("/")[0];
  const script = `/home/user/${dir}.ts`;
  await writeFile(page, script, each.program);
  const running = run(page, `bun run ${script}`, 60000);
  const deadline = Date.now() + 50000;
  while (!(await terminalText(page)).includes(`${dir} first failed`) && Date.now() < deadline) await Bun.sleep(50);
  await writeFile(page, `/home/user/${each.file}`, each.replacement);
  await writeFile(page, `/home/user/${dir}/go`, "");
  return running;
}
