import { expect, test } from "bun:test";
import { firstError } from "./classify.ts";

test("Next SWC download diagnostics remain visible after warning prefixes", () => {
  const line = '⚠ [Error: Failed to get registry from "npm".] {';
  expect(firstError(`✓ Starting...\n${line}\n  [cause]: Error: Executable not found in bun-wasm: npm`)).toBe(line);
});

test("Next SWC failure and worker exit are actionable diagnostics", () => {
  const swc = "⨯ Failed to load SWC binary for linux/wasm32, see more info here: https://nextjs.org/docs/messages/failed-loading-swc";
  expect(firstError(`⚠ Trying to load next-swc for unsupported platforms linux/wasm32\n${swc}`)).toBe(swc);
  const worker = "Next.js build worker exited with code: 1 and signal: null";
  expect(firstError(worker)).toBe(worker);
});

test("the SWC platform warning alone does not identify a terminating error", () => {
  expect(firstError("⚠ Trying to load next-swc for unsupported platforms linux/wasm32")).toBe("No diagnostic before exit or deadline");
});
