import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

test("mounted previews preserve slow guest responses past WebKit's fetch-head watchdog", () => {
  execFileSync(process.execPath, ["tests/browser-preview-navigation.ts"], { cwd: resolve(import.meta.dir, "../web"), stdio: "inherit" });
}, 260000);
