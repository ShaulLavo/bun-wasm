// Browser-guest check: the JSC parser reserve through the real executor, on the verified site.
// CI names whether this change selected the JSC producer (BUN_WASM_JSC_PRODUCER): a selected
// producer whose pair is missing from the site fails, and an unselected one leaves nothing to run.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildSite, verifySite } from "./browser-guest-site";
import { preflight } from "./goals-matrix/preparation";

const root = resolve(import.meta.dir, "..");
const selected = process.env.BUN_WASM_TEST_BROWSERS ?? "chromium";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Whether the JSC pair is expected in the site, from the producer selection CI reports. */
export function jscExpected(producer: string | undefined, ci: boolean): boolean {
  if (producer === "selected" || producer === "unselected") return producer === "selected";
  if (producer !== undefined || ci) throw new Error("CI must set BUN_WASM_JSC_PRODUCER to selected or unselected");
  return true;
}

test("the JSC producer selection is explicit in CI and required locally", () => {
  assert.equal(jscExpected("selected", true), true);
  assert.equal(jscExpected("unselected", true), false);
  assert.equal(jscExpected(undefined, false), true);
  assert.throws(() => jscExpected(undefined, true), /BUN_WASM_JSC_PRODUCER/);
  assert.throws(() => jscExpected("true", false), /BUN_WASM_JSC_PRODUCER/);
});

test("JSC parser reserve defaults, differential and instance ownership through the executor", async () => {
  assert.ok(selected === "chromium" || selected === "webkit");
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !provided) throw new Error("CI must provide its built guest site");
  const expected = jscExpected(process.env.BUN_WASM_JSC_PRODUCER, Boolean(process.env.CI));
  const scratch = provided ? undefined : mkdtempSync(join(tmpdir(), "bun-wasm-parser-reserve-site-"));
  const out = provided ? resolve(provided) : scratch!;
  try {
    const before = provided ? verifySite(out) : buildSite(out);
    const site = join(out, "site");
    const present = Boolean(before.files["bun-jsc.wasm.gz"] && before.files["jsc-engine.wasm.gz"]);
    assert.ok(present || !expected, "the JSC pair must be in the site when its producer is selected");
    if (!present) { console.log("JSC producer not selected for this change: the site has no JSC pair to check"); return; }
    await preflight(site, ["jsc"]);
    // The side this checkout finalized, when it is here: the site must serve it and the browser must fetch it.
    const finalized = join(root, "dist/jsc-engine.wasm");
    const side = existsSync(finalized) ? sha256(readFileSync(finalized)) : sha256(gunzipSync(readFileSync(join(site, "jsc-engine.wasm.gz"))));
    const browsers = selected === "webkit" ? ["webkit"] : ["chromium", "firefox"];
    execFileSync(process.execPath, ["tests/browser-jsc-parser-reserve.ts"].concat(browsers), {
      cwd: join(root, "web"), stdio: "inherit", env: { ...process.env, ROOT: site, JSC_SIDE_SHA256: side },
    });
    assert.deepEqual(verifySite(out), before);
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, 900_000);
