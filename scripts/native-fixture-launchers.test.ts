import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir(), "bun-wasm-native-fixture-launchers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const launcher = join(scratch, "bun-wasm");
const argumentsFile = join(scratch, "arguments");
// A command recorder, not a guest substitute: these tests check harness argv/env only.
writeFileSync(launcher, `#!/bin/sh
printf '%s\\n' "$@" > "$LAUNCHER_ARGUMENTS"
printf '%s\\n' "host-stack=$BUN_WASM_HOST_STACK_KIB" "cache=$BUN_WASM_CACHE_DIR" "cow=$BUN_WASM_MEMORY_INIT_COW" >> "$LAUNCHER_ARGUMENTS"
if [ -n "$LAUNCHER_EXPECTED" ]; then
  cat "$LAUNCHER_EXPECTED"
else
  printf 'completed plain 1\\ncontinued\\n'
fi
`, { mode: 0o755 });
const wasm = join(scratch, "guest with spaces.wasm");

function run(script: string, args: readonly string[], expected?: string) {
  const executable = script.endsWith(".py") ? ["python3"] : ["node", "--no-warnings"];
  const result = Bun.spawnSync(executable.concat([join(root, script)], args), {
    cwd: root,
    env: {
      ...process.env,
      BUN_WASM_LAUNCHER: launcher,
      BUN_WASM_SCRATCH_ROOT: scratch,
      BUN_WASM_CACHE_DIR: "",
      BUN_WASM_MEMORY_INIT_COW: "",
      BUN_WASM_HOST_STACK_KIB: "",
      LAUNCHER_ARGUMENTS: argumentsFile,
      LAUNCHER_EXPECTED: expected ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return { stdout: result.stdout.toString(), args: readFileSync(argumentsFile, "utf8").trimEnd().split("\n") };
}

for (const engine of ["quickjs", "jsc"]) {
  test(`open-empty-stdin harness launches ${engine} through runtime_proc host`, () => {
    const result = run("tests/test-empty-stdin.py", ["--engine", engine, "--wasm", wasm], join(root, "tests/fixtures/fs-empty-read/expected.txt"));
    expect(result.args.slice(0, 13)).toEqual([
      "--wasm", wasm, "--engine", `${engine}=${wasm}`, "--env", `PATH=/opt/bun/${engine}/bin:/bin:/usr/bin`, "--dir", `${root}/tests/fixtures/fs-empty-read::/`,
      "--env", "PWD=/", "--", "run", "/index.js",
    ]);
    expect(result.stdout).toContain(`PASS ${engine}`);
  });

  test(`partial-write harness launches ${engine} without a compiled-module cache`, () => {
    const result = run("tests/test-writev-partial.py", ["--engine", engine, "--wasm", wasm], join(root, "tests/fixtures/fs-writev-partial/expected.txt"));
    expect(result.args.slice(0, 7)).toEqual(["--wasm", wasm, "--engine", `${engine}=${wasm}`, "--env", `PATH=/opt/bun/${engine}/bin:/bin:/usr/bin`, "--dir"]);
    expect(result.args[7]!.startsWith(join(scratch, "bun-wasm-next-review-partial-"))).toBe(true);
    expect(result.args[7]!.endsWith("::/")).toBe(true);
    expect(result.args.slice(8, 13)).toEqual(["--env", "PWD=/", "--", "run", "/index.mjs"]);
    expect(result.args).toContain("cache=off");
    expect(result.args).toContain("cow=0");
    expect(result.stdout).toContain(`PASS fs-writev-partial ${engine}`);
  });
}

test("stack measurement defaults to native host and preserves host/guest stack controls", () => {
  const result = run("scripts/measure-stack.py", ["--wasm", wasm, "--stack-kib", "512", "--budget-kib", "256", "--max", "1", "plain"]);
  expect(result.args).toEqual([
    "--wasm", wasm, "--dir", `${root}/tests::/`, "--env", "PWD=/",
    "--env", "BUN_WASM_STACK_KIB=256", "--", "run", "/stack-depth.js", "plain", "1",
    "host-stack=512", "cache=", "cow=",
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({ host: "launcher", stack_kib: 512, budget_kib: 256, results: { plain: { completed_at_max: 1 } } });
});

test("Worker regression runner honors the native launcher override", () => {
  const expected = join(scratch, "worker-expected.txt");
  writeFileSync(expected, "clone transfer attached\n");
  const result = run("tests/check-worker-regressions.ts", ["--engine", "quickjs", "--wasm", wasm, "--case", "clone-atomic-transfer"], expected);
  expect(result.args.slice(0, 8)).toEqual(["--wasm", wasm, "--engine", `quickjs=${wasm}`, "--env", "PATH=/opt/bun/quickjs/bin:/bin:/usr/bin", "--", "-e"]);
  expect(result.stdout).toContain("PASS quickjs/native clone-atomic-transfer");
});

test("native Bun harnesses do not use the plain wasmtime CLI", () => {
  const migrated = [
    "scripts/test.sh", "scripts/test-build.sh", "scripts/test-bun-builtins.sh", "scripts/check-crypto-review.sh",
    "scripts/bench-jsc.sh", "scripts/bun-builtins-node.py", "scripts/measure-bun-builtins.py",
    "scripts/measure-stack.py", "tests/test-empty-stdin.py", "tests/test-writev-partial.py",
  ];
  for (const file of migrated) {
    const source = readFileSync(join(root, file), "utf8");
    expect(source).not.toMatch(/wasmtime[\"']?,?\s+[\"']?run/);
    expect(source).toContain("--wasm");
  }
});
