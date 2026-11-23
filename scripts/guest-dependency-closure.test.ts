import { expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";

// Cargo metadata/tree checks spawn `cargo`; the limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");

function cargoTree(args: readonly string[]): string {
  const result = Bun.spawnSync(["cargo", "tree", "--locked", "--offline"].concat(args), {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

function hasCrate(tree: string, name: string): boolean {
  const pattern = new RegExp(`(?:^|[\\s─└├│])${name} v\\d+\\.`);
  return pattern.test(tree);
}

test("split core guest omits unreachable bun_react_compiler and retains wasmi for its WebAssembly polyfill", () => {
  const tree = cargoTree([
    "-p", "bunwasm-cli",
    "--target", "wasm32-wasip1",
    "--no-default-features",
    "--features", "engine-split,bun-transpiler,bun-build",
  ]);
  expect(hasCrate(tree, "bun_react_compiler")).toBe(false);
  expect(hasCrate(tree, "wasmi")).toBe(true);
  expect(hasCrate(tree, "wasmparser")).toBe(true);
  expect(hasCrate(tree, "bunwasm-nested")).toBe(true);
});

test("host-engine browser guest omits unreachable bun_react_compiler, wasmi, wasmparser and bunwasm-nested", () => {
  const tree = cargoTree([
    "-p", "bunwasm-cli",
    "--target", "wasm32-wasip1",
    "--no-default-features",
    "--features", "engine-host,bun-transpiler,bun-build",
  ]);
  expect(hasCrate(tree, "bun_react_compiler")).toBe(false);
  expect(hasCrate(tree, "wasmi")).toBe(false);
  expect(hasCrate(tree, "wasmparser")).toBe(false);
  expect(hasCrate(tree, "bunwasm-nested")).toBe(false);
});

test("bun-tools guest only reaches bun_react_compiler via bun_lint_react_compiler, not bun_js_parser", () => {
  const tree = cargoTree([
    "-p", "bunwasm-tools",
    "--target", "wasm32-wasip1",
    "-i", "bun_react_compiler",
  ]);
  expect(hasCrate(tree, "bun_lint_react_compiler")).toBe(true);
  expect(hasCrate(tree, "bun_js_parser")).toBe(false);
});
