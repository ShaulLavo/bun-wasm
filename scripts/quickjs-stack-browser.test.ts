import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSite, verifySite } from "./browser-guest-site";
import { preflight } from "./goals-matrix/preparation";

const selected = process.env.BUN_WASM_TEST_BROWSERS ?? "chromium";
test("QuickJS native-call capacity and cold recursion guards", async () => {
  assert.ok(selected === "chromium" || selected === "webkit");
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
    const browsers = selected === "webkit" ? ["webkit"] : ["firefox", "chromium"];
    execFileSync(process.execPath, args.concat(browsers), options);
    const margin = selected === "webkit" ? "40" : "190";
    execFileSync(process.execPath, args.concat([selected === "webkit" ? "webkit" : "firefox"]), { ...options, env: { ...options.env, QUICKJS_STACK_KIB: margin } });
    assert.deepEqual(verifySite(out), before);
  } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}, 900_000);
