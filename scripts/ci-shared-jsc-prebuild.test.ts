import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function job(id: string): string {
  const body = workflow.split(`\n  ${id}:\n`)[1];
  if (!body) throw new Error(`Missing job ${id}`);
  return body.split(/\n  [\w-]+:\n/)[0]!;
}

test("shared C++ production starts independently of Rust and has one owner outside the bounded consumer", () => {
  const producer = job("shared-prebuild");
  const consumer = job("shared-sysroot");
  expect(producer).toContain("needs: quality");
  expect(producer).not.toContain("needs.rust");
  expect(producer).toContain("timeout-minutes: 45");
  expect(consumer).toContain("needs: [quality, rust, shared-prebuild]");
  expect(consumer).toContain("timeout-minutes: 30");
  expect(producer).toContain("JSC_PROFILE=shared-group bash scripts/build-jsc.sh");
  expect(consumer).not.toContain("bash scripts/build-jsc.sh");
  expect(consumer).not.toContain("id: shared-sysroot-cache");
  expect(consumer).not.toContain("id: shared-jsc-cache");
  expect(workflow.match(/JSC_PROFILE=shared-group bash scripts\/build-jsc.sh/g)).toHaveLength(1);
});
