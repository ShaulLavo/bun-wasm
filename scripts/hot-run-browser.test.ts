import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { chromium, webkit, type Browser } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

const root = resolve(import.meta.dir, "..");
const fixture = join(root, "tests/fixtures/cli-hot-run");

test("Node host rejects hot watching explicitly, in store/native and records/hooks modes", () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-hot-node-"));
  try {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    let guest = process.env.BUN_WASM_TEST_BROWSER_WASM ?? join(root, "dist/bun-browser.wasm");
    if (provided && !process.env.BUN_WASM_TEST_BROWSER_WASM) {
      verifySite(resolve(provided));
      guest = join(scratch, "bun-browser.wasm");
      writeFileSync(guest, gunzipSync(readFileSync(join(provided, "site/bun-browser.wasm.gz"))));
    }
    for (const [modules, context] of [["store", "native"], ["records", "hooks"]]) {
      const child = spawnSync("node", ["--no-warnings", join(root, "web/scripts/node-host.mjs"), "--wasm", guest,
        "--modules", modules!, "--context", context!, "--dir", `${fixture}::/`, "--env", "PWD=/", "--", "--hot", "run", "/index.ts"],
      { encoding: "utf8", timeout: 15000 });
      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
      expect(child.stderr).toContain("ENOTSUP");
      expect(child.stderr).toContain("watch");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 40000);

for (const browserName of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${browserName}: actual Waffle hot server keeps its process, server and in-flight response`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    if (process.env.CI && !provided) throw new Error("CI must provide the existing browser-guest site");
    const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-hot-site-"));
    const directory = provided ? resolve(provided) : scratch!;
    const previousRoot = process.env.ROOT;
    const task = session("bun-wasm-hot-browser-");
    try {
      const before = provided ? verifySite(directory) : buildSite(directory);
      process.env.ROOT = join(directory, "site");
      const url = await task.serve();
      if (browserName !== "chromium" && browserName !== "webkit") throw new Error(`Unsupported browser ${browserName}`);
      const browser = await task.launch(browserName === "chromium" ? chromium : webkit);
      await scenario(browser, url);
      expect(verifySite(directory)).toEqual(before);
    } finally {
      if (previousRoot === undefined) delete process.env.ROOT;
      else process.env.ROOT = previousRoot;
      await task.cleanup();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }, 300000);
}


async function scenario(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
        const page = await context.newPage();
        await page.goto(`${url}?engine=browser&prompt=off&mode=memory`);
        expect(await ready(page)).toContain("ready");
        for (const file of readdirSync(fixture)) {
          if (!/\.(ts|cjs|html|json)$/.test(file)) continue;
          await writeFile(page, `/home/user/${file}`, readFileSync(join(fixture, file), "utf8"));
        }
        const result = await run(page, "bun --hot run index.ts", 60000);
        expect(result.code, result.output).toBe(0);
        for (const line of readFileSync(join(fixture, "expected.txt"), "utf8").trim().split("\n")) expect(result.output).toContain(line);
  } finally { await context.close(); }

}
