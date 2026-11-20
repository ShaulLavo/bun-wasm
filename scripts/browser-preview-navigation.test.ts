import { setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("mounted previews preserve slow guest responses past WebKit's fetch-head watchdog", () => {
  execFileSync(process.execPath, ["tests/browser-preview-navigation.ts"], { cwd: resolve(import.meta.dir, "../web"), stdio: "inherit" });
}, 260000);
