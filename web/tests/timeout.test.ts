import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const script = new URL("../../scripts/run-with-timeout.mts", import.meta.url).pathname;
for (const code of [0, 23]) {
  test(`portable command deadline preserves exit ${code}`, () => {
    const result = spawnSync("node", [script, "5", "node", "-e", `process.exit(${code})`], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(code);
    expect(result.stderr).toBe("");
  });
}
test("portable command deadline kills an overlong command", () => {
  const result = spawnSync("node", [script, "0.1", "node", "-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(124);
  expect(result.stderr).toContain("ETIMEDOUT");
});
