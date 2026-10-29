import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "../tests/fixtures/async-context-runtime/index.ts");

function reportFrom(output: string): Record<string, unknown> {
  const line = output.split("\n").find(value => value.startsWith("CTX01_RESULT "));
  expect(line, output).toBeDefined();
  return JSON.parse(line!.slice("CTX01_RESULT ".length)) as Record<string, unknown>;
}

test("Node reference keeps ALS across runtime-generated code", () => {
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fixture], { encoding: "utf8", timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const report = reportFrom(result.stdout);
  expect(report.status).toBe("pass");
  expect(report.failures).toEqual([]);
  expect((report.origins as unknown[]).length).toBeGreaterThanOrEqual(12);
  expect((report.cases as unknown[]).some(value => (value as { name: string }).name === "compiled-once-reused")).toBe(true);
});
