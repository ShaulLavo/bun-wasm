import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testCompose } from "./compose";

const root = resolve(import.meta.dir, "../..");

test("browser guest preserves require.main when await hooks reprint CommonJS", () => {
  const fixture = resolve(root, "tests/fixtures/module-syntax");
  const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM || resolve(root, "dist/bun-browser.wasm");
  const child = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"),
    "--wasm", wasm, "--dir", `${fixture}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/index.js"],
  { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(child.error).toBeUndefined();
  expect(child.stdout).toBe(readFileSync(resolve(fixture, "expected.txt"), "utf8"));
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
}, 30000);

// Frames the printed hooks can't reproduce yet (docs/engine-browser.md): a
// rejection out of `yield*` caught in the delegating generator (G1), and a
// generator's `finally` after return() from another frame (G2). A fix shows up
// here as a failure.
const hookGaps: Record<string, string> = {
  "P4 delegate.catch=d3": "P4 delegate.catch=d1",
  "P4 return.finally=r2": "P4 return.finally=r1",
};

test("browser guest keeps AsyncLocalStorage across rejected awaits, handlers, generators and for await", () => {
  const fixture = resolve(root, "tests/async-context-rejection");
  const reference = spawnSync("node", ["--disable-warning=ExperimentalWarning", resolve(fixture, "index.ts")],
    { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(reference.status, reference.stderr).toBe(0);
  const lines = reference.stdout.split("\n");
  expect(lines).toContain("P1 observations=34 mismatches=0");
  const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM || resolve(root, "dist/bun-browser.wasm");
  for (const context of ["hooks", "native"]) {
    const child = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"), "--wasm", wasm,
      "--context", context, "--dir", `${fixture}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/index.ts"],
    { cwd: root, encoding: "utf8", timeout: 30000 });
    expect(child.stderr).toBe("");
    const expected = context === "hooks" ? lines.map(line => hookGaps[line] ?? line) : lines;
    expect(child.stdout.split("\n")).toEqual(expected);
    expect(child.status).toBe(0);
  }
}, 70000);

test("browser guest prepares runtime-built constructors, lexical eval, wrappers and source columns", () => {
  const fixture = resolve(root, "tests/async-context-runtime");
  const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM || resolve(root, "dist/bun-browser.wasm");
  for (const context of ["hooks", "native"]) {
    const child = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"), "--wasm", wasm,
      "--context", context, "--dir", `${fixture}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/prepare-probe.ts"],
    { cwd: root, encoding: "utf8", timeout: 30000 });
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(child.stdout).toBe("PREPARE_OK\n");
    expect(child.stderr).toBe("");
  }
  for (const [fixtureName, expected] of [["prepare-transforms", "PREPARE_TRANSFORMS_OK"], ["prepare-cache", "PREPARE_CACHE_OK"], ["prepare-parent-loop", '{"dynamicRows":["loop","loop"],"printedRows":["loop","loop"]}']]) {
    const transformed = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"), "--wasm", wasm,
      "--context", "hooks", "--dir", `${fixture}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "run", `/${fixtureName}.ts`],
    { cwd: root, encoding: "utf8", timeout: 30000 });
    expect(transformed.status, transformed.stderr + transformed.stdout).toBe(0);
    expect(transformed.stdout).toBe(`${expected}\n`);
    expect(transformed.stderr).toBe("");
  }
}, 100000);

test("browser guest prepares the complete rejection and iterator fixture at runtime", () => {
  const fixture = resolve(root, "tests/async-context-runtime");
  const rejection = resolve(root, "tests/async-context-rejection");
  const reference = spawnSync("node", ["--no-warnings", resolve(rejection, "index.ts")], { encoding: "utf8", timeout: 30000 });
  expect(reference.status, reference.stderr).toBe(0);
  const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM || resolve(root, "dist/bun-browser.wasm");
  for (const context of ["hooks", "native"]) {
    for (const route of ["constructor", "eval", "vm"]) {
      const child = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"), "--wasm", wasm,
        "--context", context, "--dir", `${fixture}::/`, "--dir", `${rejection}::/rejection`, "--env", "PWD=/", "--env", "HOME=/",
        "--", "run", "/prepare-runtime-rejection.ts", route], { cwd: root, encoding: "utf8", timeout: 30000 });
      const expected = context === "hooks" ? reference.stdout.split("\n").map(line => hookGaps[line] ?? line).join("\n") : reference.stdout;
      expect(child.status, `${context}/${route}: ${child.stderr}${child.stdout}`).toBe(0);
      expect(child.stdout).toBe(expected);
      expect(child.stderr).toBe("");
    }
  }
}, 190000);

test("fresh Node-hosted WASM subprocesses preserve stdio, cwd, files, exits and signals", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("../tests/subprocess.mjs", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 100000 });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("9 subprocess worker checks passed\n");
}, 105000);

testCompose("bun-browser.wasm");
