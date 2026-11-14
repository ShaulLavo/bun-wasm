import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeCheck } from "./quickjs-native-check";

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result.stdout.trim();
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function differingLabels(left: unknown, right: unknown): string[] {
  if (!Array.isArray(left) || !Array.isArray(right)) throw new Error("Expected semantic trace arrays");
  expect(left.length).toBe(right.length);
  return left.flatMap((row: unknown, index) => {
    if (!Array.isArray(row) || typeof row[0] !== "string") throw new Error("Expected labelled semantic trace");
    return JSON.stringify(row) === JSON.stringify(right[index]) ? [] : [row[0]];
  });
}

function linkInputs(root: string, engine: string): string[] {
  const produced = process.env.BUN_WASM_QUICKJS_OUT_DIR;
  const build = join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/build/rquickjs-sys");
  const candidates = produced ? [produced] : existsSync(build) ? readdirSync(build).sort().map(name => join(build, name, "out")) : [];
  const inputs = readdirSync(engine).filter(name => /\.[ch]$/.test(name));
  const matches = (directory: string): boolean => inputs.every(name => existsSync(join(directory, name)) && readFileSync(join(directory, name)).equals(readFileSync(join(engine, name))));
  const output = candidates.find(directory => existsSync(join(directory, "libquickjs.a")) && matches(directory));
  if (output) return [join(output, "libquickjs.a")];
  if (produced || process.env.CI === "true") throw new Error("Missing produced native QuickJS archive matching every vendored C/header input");
  return ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"].map(name => join(engine, name));
}

test("RegExp.test preserves native semantics and the separate baseline Node differences", () => {
  const check = nativeCheck("bun-wasm-regexp-test-", process.env.QUICKJS_REGEXP_SOURCE);
  const fixture = join(check.root, "scripts/fixtures/quickjs-regexp-test");
  try {
    const binary = join(check.scratch, "regexp-test");
    const sources = linkInputs(check.root, check.engine);
    run(process.env.CC ?? "cc", ["-D_GNU_SOURCE", "-std=gnu11", "-O1", "-g", "-I", check.engine, fixture + ".c"].concat(sources, ["-lm", "-lpthread", "-o", binary]));
    const input = new Bun.Transpiler({ loader: "ts" }).transformSync(readFileSync(fixture + ".ts", "utf8"));
    const nativeInput = join(check.scratch, "native.js");
    const nodeInput = join(check.scratch, "node.js");
    writeFileSync(nativeInput, "const console={log:print};\n" + input);
    writeFileSync(nodeInput, input);
    const actual: unknown = JSON.parse(run(binary, [nativeInput]));
    const node: unknown = JSON.parse(run("node", [nodeInput]));
    const baseline = read(fixture + ".baseline.json");
    const nodeBaseline = read(fixture + ".node.json");
    expect(actual).toEqual(baseline);
    expect(node).toEqual(nodeBaseline);
    expect(differingLabels(actual, node)).toEqual(differingLabels(baseline, nodeBaseline));
    expect(differingLabels(actual, node)).toHaveLength(20);
    expect(run(binary, ["--native"])).toContain("realm, frame, stack, interrupt, allocation failure and recovery: passed");
    console.log(JSON.stringify({ sourceSha256: createHash("sha256").update(readFileSync(join(check.engine, "quickjs.c"))).digest("hex"), semanticRows: Array.isArray(actual) ? actual.length : 0, preservedBaselineNodeDifferences: 20 }));
  } finally {
    check.cleanup();
    expect(existsSync(check.scratch)).toBe(false);
  }
}, 240000);
