import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const controls: [string, string][] = [["node", "native"], ["bun", "native"], ["node", "factory"]];
for (const [runtime, mode] of controls) {
  test(`${runtime} ${mode} rejection capture, disabled behavior and observer teardown`, () => {
    const result = spawnSync(runtime, [`${import.meta.dir}/fixtures/event-rejections-control.ts`, mode], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      encoding: "utf8", timeout: 4000, killSignal: "SIGKILL",
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("observer teardown restored its original listener count");
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });
}
