import { tmpdir } from "node:os";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("stack measurement gives the require mode a private scratch preopen and an optional package leaf", () => {
  const project = join(scratch, "leaf project");
  mkdirSync(project);
  const result = run("scripts/measure-stack.py", ["--wasm", wasm, "--max", "1", "--leaf-root", project, "--leaf", "node_modules/pkg/index.js", "require"]);
  const chain = result.args[7]!.replace(/::\/stack-depth-scratch$/, "");
  expect(chain.startsWith(join(scratch, "bun-wasm-stack-require-"))).toBe(true);
  expect(existsSync(chain)).toBe(false);
  expect(result.args.slice(0, 7)).toEqual(["--wasm", wasm, "--dir", `${root}/tests::/`, "--env", "PWD=/", "--dir"]);
  expect(result.args.slice(8, 19)).toEqual([
    "--env", "STACK_DEPTH_DIR=/stack-depth-scratch", "--dir", `${project}::/stack-depth-leaf`,
    "--env", "STACK_DEPTH_LEAF=/stack-depth-leaf/node_modules/pkg/index.js", "--", "run", "/stack-depth.js", "require", "1",
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({ leaf: "node_modules/pkg/index.js", results: { require: { completed_at_max: 1 } } });
});

test("stack measurement distinguishes a failing package leaf from a passing zero-depth chain", () => {
  const expected = join(scratch, "refused-at-zero.txt");
  writeFileSync(expected, "caught require RangeError 0 Maximum call stack size exceeded\ncontinued\n");
  const result = run("scripts/measure-stack.py", ["--wasm", wasm, "--max", "1", "require"], expected);
  expect(JSON.parse(result.stdout)).toMatchObject({ results: { require: { refused_at_zero: "caught:RangeError" } } });
  expect(result.args.slice(-5, -3)).toEqual(["require", "0"]);
});

function probeRequire(depth: string, leaf?: string) {
  const directory = mkdtempSync(join(scratch, "require-probe-"));
  const result = Bun.spawnSync([process.execPath, join(root, "tests/stack-depth.js"), "require", depth], {
    env: { ...process.env, STACK_DEPTH_DIR: directory, STACK_DEPTH_LEAF: leaf ?? "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  return { stdout: result.stdout.toString(), left: readdirSync(directory) };
}

test("require probe loads its generated chain, reports a failing leaf and removes the chain both times", () => {
  expect(probeRequire("3")).toEqual({ stdout: "completed require 3\ncontinued\n", left: [] });
  const missing = probeRequire("2", join(scratch, "missing-leaf.cjs"));
  expect(missing.stdout).toMatch(/^caught require \w+ 2 .*missing-leaf\.cjs/);
  expect(missing.stdout.endsWith("\ncontinued\n")).toBe(true);
  expect(missing.left).toEqual([]);
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
    "scripts/bench-engines.ts", "scripts/bun-builtins-node.py", "scripts/measure-bun-builtins.py",
    "scripts/measure-stack.py", "tests/test-empty-stdin.py", "tests/test-writev-partial.py",
  ];
  for (const file of migrated) {
    const source = readFileSync(join(root, file), "utf8");
    expect(source).not.toMatch(/wasmtime["']?,?\s+["']?run/);
    expect(source).toContain("--wasm");
  }
});
