import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { buildSite, verifySite, type SiteIdentity } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { preflight } from "./goals-matrix/preparation";
import { verifyPreparedSiteInventory } from "./goals-matrix/prepared-site";
import { ready, command } from "./goals-matrix/playground";
import { engineMemoryLog, decodeMemoryObservation } from "./goals-matrix/browser-memory";
import { memoryControlCommand, assertMemoryControl } from "./goals-matrix/memory-control";
import { evaluatePage, type Transport } from "./goals-matrix/transport";
import { withScoped } from "./goals-matrix/scope-fixture";

const root = resolve(import.meta.dir, "..");
const pairFiles = ["bun-spidermonkey.wasm", "spidermonkey-engine.wasm"];

async function verifyLocalPreparedSite(site: string): Promise<string> {
  await verifyPreparedSiteInventory(site);
  const source = JSON.parse(readFileSync(join(site, "goals-host-source.json"), "utf8"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "local host source must be clean and match its prepared inventory").toBe("");
  expect(source).toMatchObject({ commit: head, dirty: false, profile: "split" });
  const sources = readFileSync(join(site, "goals-asset-sources.json"), "utf8");
  const inventory = readFileSync(join(site, "goals-site-inventory.json"), "utf8");
  for (const file of pairFiles) expect(inventory).toContain(file + ".gz");
  return JSON.stringify({ source, sources, inventory });
}
function requirePairInventory(identity: SiteIdentity | string): void {
  if (typeof identity === "string") return;
  for (const file of pairFiles) expect(identity.files[file + ".gz"], "both ordinary SM assets are required").toBeTruthy();
}

for (const name of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${name}: real split/interpreter SpiderMonkey retains synchronous-child libc observations`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    const localPrepared = process.env.BUN_WASM_MEMORY_PREPARED_SITE;
    if (process.env.CI && (!provided || localPrepared)) throw Error("CI must consume BUN_WASM_BROWSER_SITE from the existing Rust producer");
    if (provided && localPrepared) throw Error("Choose the CI site or explicitly labeled local prepared site");
    const scratch = provided || localPrepared ? undefined : mkdtempSync(join(tmpdir(), "bun-wasm-sm-memory-site-"));
    const directory = resolve(provided ?? scratch ?? localPrepared!);
    const site = localPrepared ? resolve(localPrepared) : join(directory, "site");
    const previousRoot = process.env.ROOT;
    const task = session("bun-wasm-sm-memory-");
    try {
      const before = localPrepared ? await verifyLocalPreparedSite(site) : provided ? verifySite(directory) : buildSite(directory);
      requirePairInventory(before);
      const builds = JSON.parse(readFileSync(join(site, "engine-builds.json"), "utf8"));
      for (const file of pairFiles) expect(builds[file], "both ordinary SM engine fingerprints are required").toMatch(/^[a-f0-9]{64}$/);
      await preflight(site, ["spidermonkey"], "split");
      process.env.ROOT = site;
      const url = await task.serve();
      if (name !== "chromium" && name !== "webkit") throw Error(`Unsupported browser ${name}`);
      const browser = await task.launch(name === "chromium" ? chromium : webkit);
      await scenario(browser, url);
      expect(localPrepared ? await verifyLocalPreparedSite(site) : verifySite(directory)).toEqual(before);
    } finally {
      if (previousRoot === undefined) delete process.env.ROOT;
      else process.env.ROOT = previousRoot;
      await task.cleanup();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }, 300000);
}

function pageTransport(page: Page): Transport {
  return { capabilities: { realPage: true }, async navigate(url) { await page.goto(url); },
    evaluate: <T>(expression: string, admission: Parameters<Transport["evaluate"]>[1], options?: Parameters<Transport["evaluate"]>[2]) => evaluatePage<T>(page, expression, 120000, admission, options),
    async useHost() {}, async usePreview() {}, async openPreview() {}, async closePreview() {}, async close() { await page.close(); } };
}
async function scenario(browser: Browser, url: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const host = await context.newPage();
    await withScoped(pageTransport(host), async page => {
      await page.navigate(`${url}?engine=spidermonkey&profile=split&prompt=off&mode=memory`);
      await ready(page, "spidermonkey", 120000, "split");
      const result = await command(page, memoryControlCommand(), 120000);
      expect(result).toHaveProperty("code", 0);
      if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string") throw Error("Missing real control transcript");
      console.log(JSON.stringify({ transcript: result.output }));
      const log = await engineMemoryLog(page, "spidermonkey");
      const marker = "SpiderMonkey process memory observation:\n";
      expect(log).toContain(marker);
      const observation = decodeMemoryObservation(JSON.parse(log.slice(log.indexOf(marker) + marker.length)));
      console.log(JSON.stringify({ observation }));
      const control = assertMemoryControl(result.output, observation);
      console.log(JSON.stringify({ control }));
    }, 240000);
  } finally { await context.close(); }
}
