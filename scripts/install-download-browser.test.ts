import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { assertClosed, fixture } from "./install-download-fixture";
import { ready, run, session, writeFile } from "../web/tests/playground.mjs";

for (const name of (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",")) {
  test(`${name}: Waffle metadata and archives overlap under body backpressure`, async () => {
    const provided = process.env.BUN_WASM_BROWSER_SITE;
    if (process.env.CI && !provided) throw new Error("CI must supply BUN_WASM_BROWSER_SITE");
    const scratch = provided ? undefined : mkdtempSync(join(tmpdir(), "bun-wasm-download-site-"));
    const out = provided ? resolve(provided) : scratch!;
    const task = session("bun-wasm-download-browser-");
    const previousRoot = process.env.ROOT;
    process.env.ROOT = join(out, "site");
    try {
      const before = provided ? verifySite(out) : buildSite(out);
      assert.ok(name === "chromium" || name === "webkit", `unsupported browser ${name}`);
      const url = await task.serve();
      const browser = await task.launch(name === "chromium" ? chromium : webkit);
      for (const stage of ["metadata", "tarball"] as const) await scenario(browser, url, stage);
      await scenario(browser, url, "metadata", "parents");
      assert.deepEqual(verifySite(out), before);
    } finally {
      if (previousRoot === undefined) delete process.env.ROOT;
      else process.env.ROOT = previousRoot;
      await task.cleanup();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }, 180000);
}

async function scenario(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string, stage: "metadata" | "tarball", topology: "siblings" | "parents" = "siblings") {
  const registry = await fixture(stage, topology);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${url}?engine=browser&prompt=off&mode=memory`);
    assert.match(await ready(page), /ready/);
    await writeFile(page, "/home/user/package.json", JSON.stringify({ name: "fixture", dependencies: registry.dependencies }));
    await writeFile(page, "/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(registry.base)}\n`);
    const result = await run(page, stage === "metadata" ? "bun install --lockfile-only" : "bun install", 30000);
    assert.equal(result.code, 0, result.output);
    assert.equal(registry.trace.missedBarrier, false, `${stage} ${topology} did not overlap`);
    if (topology === "parents") assert.equal(registry.trace.requests.length, 40, "cross-parent lookahead duplicated requests");
    assert.ok(registry.trace.peak > 1 && registry.trace.peak <= 8, `${stage} concurrency ${registry.trace.peak}`);
    console.log(`${browser.browserType().name()} Waffle ${stage}: ${result.ms} ms, peak ${registry.trace.peak}, body exceeds per-handle window`);
    const requests = registry.trace.requests.length;
    const warm = await run(page, stage === "metadata" ? "bun install --lockfile-only --frozen-lockfile" : "bun install --frozen-lockfile", 30000);
    assert.equal(warm.code, 0, warm.output);
    assert.equal(registry.trace.requests.length, requests, "warm install performed network work");
    await writeFile(page, "/home/user/package.json", JSON.stringify({ dependencies: { "a-fail": "1.0.0", "b-stall": "1.0.0" } }));
    const failed = await run(page, stage === "metadata" ? "bun install --lockfile-only" : "bun install", 30000);
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /503/);
    await assertClosed(registry.trace);

  } finally {
    await context.close();
    await registry.close();
  }
}
