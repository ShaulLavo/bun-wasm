// Browser-guest check: the worker module loader in Chromium and WebKit, on the playground site
// built from this checkout's browser guest (scripts/browser-guest-site.ts). CI's rust job builds
// that site once and each browser leg passes it in BUN_WASM_BROWSER_SITE; the check verifies its
// closed inventory and source before and after the browsers run and never bundles it again.
// A local run without BUN_WASM_BROWSER_SITE builds one in scratch from dist/bun-browser.wasm.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSite, verifySite } from "./browser-guest-site";

const root = resolve(import.meta.dir, "..");

test("worker ES module cycles load without a service-worker controller, on this checkout's site", () => {
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !provided) throw new Error("CI must pass the rust job's site in BUN_WASM_BROWSER_SITE");
  const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-browser-site-"));
  const out = provided ? resolve(provided) : scratch!;
  try {
    const before = provided ? verifySite(out) : buildSite(out);
    console.log(JSON.stringify({ source: before.source, guest: before.guest, files: Object.keys(before.files).length }));
    const browsers = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
    execFileSync(process.execPath, ["tests/browser-module-records.ts"].concat(browsers), {
      cwd: join(root, "web"), stdio: "inherit", env: { ...process.env, MODULE_RECORDS_ROOT: join(out, "site") },
    });
    expect(verifySite(out)).toEqual(before);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}, 900_000);
