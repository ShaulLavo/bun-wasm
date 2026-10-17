import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-runtime-types-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const probe = join(scratch, "probe.ts");
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
  include: [],
  files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), probe],
}));

function check(source: string) {
  writeFileSync(probe, 'declare const native: BunWasm.Native;\n' + source);
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("accepts the positional glob native contract including its optional flag", () => {
  expect(check('native.globScan("*", "/", false, false, false, false, true);\nnative.globScan("*", "/", false, false, false, false, true, true);').exitCode).toBe(0);
});

const invalid: [string, string][] = [
  ["missing cwd", 'native.globScan("*");'],
  ["boolean cwd", 'native.globScan("*", true, false, false, false, false, true);'],
  ["string flag", 'native.globScan("*", "/", "not a flag", false, false, false, true);'],
  ["string optional flag", 'native.globScan("*", "/", false, false, false, false, true, "not a flag");'],
  ["runtime type error", 'const value: number = "wrong";'],
];
for (const [label, source] of invalid) {
  test(`rejects ${label}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
