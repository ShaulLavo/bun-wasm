import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { qualityGates } from "./quality";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const quality = workflow.split("\n  quality:\n")[1]!.split("\n  rust:\n")[0]!;
const rust = workflow.split("\n  rust:\n")[1]!.split("\n  package:\n")[0]!;

test("JavaScript quality does not set up or compile Rust", () => {
  expect(quality).toContain("bun run quality --javascript");
  expect(quality).not.toContain("rust-toolchain");
  expect(quality).not.toContain("sync-bun.sh");
});

test("native checks share one conditional job and the cached target directory", () => {
  expect(rust).toContain("needs.quality.outputs.rust == 'true'");
  expect(rust).toContain("CARGO_TARGET_DIR=$GITHUB_WORKSPACE/target");
  expect(rust).toContain("${{ env.CARGO_TARGET_DIR }}");
  expect(rust).toContain("${{ env.CARGO_HOME }}/registry");
  expect(rust).toContain("restore-keys: native-v2-");
  expect(rust).not.toContain("Swatinem/rust-cache");
  expect(rust).toContain("bun run quality --native");
  expect(rust).not.toContain("cargo test");
});

test("Rust tests are compiled and run once, with Clippy covering test targets", () => {
  const script = readFileSync(new URL("./quality-rust.ts", import.meta.url), "utf8");
  expect(script.match(/"cargo", "test"/g)).toHaveLength(1);
  expect(script).toContain('"--all-targets", "--release", "--no-deps"');
  expect(script).toContain('"test", "--locked", "--workspace", "--release"');
});


test("local quality retains all gates and rejects invalid selections", () => {
  expect(qualityGates([])).toEqual(qualityGates(["--javascript"]).concat(qualityGates(["--native"])));
  expect(qualityGates(["--javascript"])).toEqual(["lint", "types", "unused", "duplicates", "probes"]);
  expect(qualityGates(["--native"])).toEqual(["rust", "wasi"]);
  expect(() => qualityGates(["--wat"])).toThrow("Usage");
  expect(() => qualityGates(["--javascript", "--native"])).toThrow("Usage");
});

test("type projects have one successful CI owner", () => {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const web = readFileSync(new URL("./test-web-host.sh", import.meta.url), "utf8");
  expect(manifest).not.toContain("tsc -p crates/bunwasm-runtime/tsconfig.json &&");
  expect(manifest).not.toContain("&& tsc -p tsconfig.package.json &&");
  expect(web).toContain("tsc -p ../crates/bunwasm-runtime/tsconfig.json");
  expect(workflow.split("\n  package:\n")[1]!.split("\n  web:\n")[0]).toContain("bun run check");
});
