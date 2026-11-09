import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSite, verifySite } from "./browser-guest-site";
import { preflight } from "./goals-matrix/preparation";

// Chromium's browser-guest leg installs both hosts and owns this check once.
// Safari's smaller stack policy is covered by the existing browser-stack probe.
const selected = process.env.BUN_WASM_TEST_BROWSERS ?? "chromium";
test.skipIf(selected === "webkit")("QuickJS's Firefox capacity and cold recursion guards on both hosts", async () => {
  assert.equal(selected, "chromium", "Chromium's browser-guest leg owns the Firefox/Chromium probe");
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !provided) throw new Error("CI must provide its built guest site");
  const scratch = provided ? undefined : mkdtempSync(join(tmpdir(), "bun-wasm-stack-site-"));
  const out = provided ? resolve(provided) : scratch!;
  try {
    const before = provided ? verifySite(out) : buildSite(out);
    const site = join(out, "site");
    assert.ok(before.files["bun.wasm.gz"] && before.files["quickjs.wasm.gz"], "QuickJS guests must be built before the blocking check");
    await preflight(site, ["quickjs"]);
    const args = ["tests/browser-quickjs-stack.ts"];
    const options = { cwd: resolve(import.meta.dir, "../web"), stdio: "inherit", env: { ...process.env, ROOT: site, QUICKJS_STACK_KIB: undefined } } as const;
    execFileSync(process.execPath, args.concat(["firefox", "chromium"]), options);
    execFileSync(process.execPath, args.concat(["firefox"]), { ...options, env: { ...options.env, QUICKJS_STACK_KIB: "190" } });
    assert.deepEqual(verifySite(out), before);
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, 900_000);
