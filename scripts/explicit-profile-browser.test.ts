import { setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("explicit shared profile uses the production playground, shell and workers", () => {
  if (!process.env.BUN_WASM_PROFILE_PROGRAM || !process.env.BUN_WASM_BROWSER_SITE) {
    throw new Error("The shared check requires its existing program producer and verified playground site");
  }
  execFileSync(process.execPath, ["web/tests/explicit-profile-browser.ts"], { cwd: new URL("..", import.meta.url), stdio: "inherit", env: process.env });
}, 330_000);
