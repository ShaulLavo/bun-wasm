import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected workflow object");
  return Object.fromEntries(Object.entries(value));
}
const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobs = record(record(Bun.YAML.parse(source)).jobs);

test("native quality has a bounded checkpoint before the unchanged final native gate", () => {
  expect(record(jobs["native-quality"])["timeout-minutes"]).toBe(45);
  expect(record(jobs.rust)["timeout-minutes"]).toBe(60);
  expect(record(jobs["jsc-prebuild"])["timeout-minutes"]).toBe(45);
  expect(record(jobs.rust).needs).toEqual(["quality", "jsc-prebuild", "native-quality"]);
});
