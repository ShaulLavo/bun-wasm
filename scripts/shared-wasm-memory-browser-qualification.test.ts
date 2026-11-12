import { expect, test } from "bun:test";
import { join } from "node:path";
import { selectChecks } from "./test-checks.ts";

const root = join(import.meta.dir, "..");
const wrapper = join(import.meta.dir, "shared-wasm-memory-browser.test.ts");
const diagnostics = ["SHARED_WASM_CONTROL", "SHARED_WASM_ENTRY", "SHARED_WASM_OXC_TREE"];

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of diagnostics) delete env[name];
  delete env.BUN_WASM_PROFILE_PROGRAM;
  return env;
}

function runWrapper(env: NodeJS.ProcessEnv) {
  const child = Bun.spawnSync([process.execPath, "test", wrapper], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: child.exitCode, output: Buffer.concat([child.stdout, child.stderr]).toString() };
}

for (const name of diagnostics) {
  test.each(["", "override"])(`qualification rejects ${name}=%j before opening a producer`, value => {
    const env = environment();
    env[name] = value;
    env.BUN_WASM_PROFILE_PROGRAM = join(root, "absent-qualification-producer.wasm");
    const result = runWrapper(env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(`error: Shared-group qualification refuses diagnostic override: ${name}`);
    expect(result.output).not.toContain("ENOENT");
  });
}

test("qualification without overrides retains the missing-producer refusal", () => {
  const result = runWrapper(environment());
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("error: Set BUN_WASM_PROFILE_PROGRAM to a matching shared-group guest");
  expect(result.output).not.toContain("error: Shared-group qualification refuses diagnostic override");
});

test("qualification guards retain their quality and shared-group browser owners", () => {
  expect(selectChecks("quality")).toContain("scripts/shared-wasm-memory-browser-qualification.test.ts");
  expect(selectChecks("browser-guest", undefined, "shared-group")).toContain("scripts/shared-wasm-memory-browser.test.ts");
});

test("default shared publication policy belongs only to split native discovery", () => {
  expect(selectChecks("native")).toContain("tests/fixtures/worker-shared-default");
  expect(selectChecks("native", undefined, "shared-group")).not.toContain("tests/fixtures/worker-shared-default");
});
