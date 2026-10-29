import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { needsSharedSysroot } from "./ci-changes";
import { discoverChecks } from "./test-checks";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const shared = workflow.split("\n  shared-sysroot:\n")[1]!.split("\n  web:\n")[0]!;

test("the dedicated shared profile gate is blocking and never invokes an engine build", () => {
  expect(shared).toContain("needs: quality");
  expect(shared).toContain("if: needs.quality.outputs.shared == 'true'");
  expect(shared).toContain("node-version: '26'");
  expect(shared).toContain("TMPDIR: ${{ runner.temp }}");
  expect(shared).toContain("bun scripts/build-wasi-sysroot.ts --shared-pic --inputs");
  expect(shared).toContain("bun scripts/build-wasi-sysroot.ts --shared-pic\n");
  expect(shared).toContain('bash scripts/test-shared-sysroot.sh "$RUNNER_TEMP/shared-sysroot-proof"');
  expect(shared).not.toMatch(/continue-on-error|cargo |build-engine|build-bun|sync-bun/);
  expect(shared).toContain("v1.262.0/wasm-tools");
  expect(shared).toContain("v49.0.3/wasmtime");
  expect(shared).toContain("key: wasi-sdk-34.0-stock-${{ runner.os }}-${{ runner.arch }}");
  expect(shared).toContain("key: wasi-shared-pic-v1-${{ runner.os }}-${{ runner.arch }}-${{ steps.shared-inputs.outputs.hash }}");
  expect(shared).toContain('path: ${{ env.BUN_WASM_SHARED_SYSROOT }}');
  expect(shared).not.toContain("bun-wasm-sysroot-patched");
});

test("default and shared input isolation has one lightweight blocking owner", () => {
  expect(discoverChecks().filter(check => check.path === "scripts/shared-sysroot-inputs.test.ts"))
    .toEqual([{ owner: "quality", path: "scripts/shared-sysroot-inputs.test.ts", localRuntime: false, batch: "default" }]);
  expect(needsSharedSysroot(["scripts/shared-sysroot-inputs.test.ts"])).toBe(true);
  expect(needsSharedSysroot(["scripts/shared-sysroot-ci.test.ts"])).toBe(true);
});
