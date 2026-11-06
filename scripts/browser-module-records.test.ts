import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("worker ES module cycles load without a service-worker controller in Chromium and WebKit", () => {
  execFileSync(process.execPath, ["tests/browser-module-records.ts", "chromium", "webkit"], {
    cwd: resolve(import.meta.dir, "../web"),
    stdio: "inherit",
  });
}, 600_000);
