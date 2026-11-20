import { setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

test("preview registration stays on demand in root and nested Chromium and WebKit mounts", () => {
  execFileSync(process.execPath, ["tests/browser-preview-loading.ts", "chromium", "webkit"], {
    cwd: resolve(import.meta.dir, "../web"),
    stdio: "inherit",
  });
}, 200_000);
