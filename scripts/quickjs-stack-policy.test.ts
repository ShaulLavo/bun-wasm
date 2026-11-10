import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

for (const budget of [undefined, "45"]) test(`discovered WebKit stack controls preserve inputs at ${budget ?? "selected policy"}`, () => {
  const child = spawnSync(process.execPath, [new URL("./fixtures/quickjs-stack-policy.ts", import.meta.url).pathname], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, QUICKJS_STACK_KIB: budget },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr + child.stdout).toBe(0);
  expect(child.stdout).toContain('"probes":25');
  expect(child.stdout).toContain(`"budget":"${budget ?? "policy"}"`);
});
