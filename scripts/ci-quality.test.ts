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
  expect(rust).toContain("restore-keys: native-v");
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

test("both WASI feature graphs and the failing lint control stay blocking", () => {
  const wasi = readFileSync(new URL("./quality-wasi.ts", import.meta.url), "utf8");
  expect(wasi.match(/run\(command\.concat/g)).toHaveLength(2);
  expect(wasi).toContain('"--no-default-features", "--features", "bunwasm-cli/engine-host,bunwasm-cli/bun-transpiler,bunwasm-cli/bun-build"');
  expect(wasi).toContain('await verifyWasiLint(["cargo", "clippy"');
});

test("cached build inputs are compared before the native gate", () => {
  const inputTimes = rust.indexOf("bun scripts/quality-input-times.ts");
  expect(inputTimes).toBeGreaterThan(rust.indexOf("name: Prepare pinned upstream sources"));
  expect(inputTimes).toBeGreaterThan(rust.indexOf("id: native-cache"));
  expect(inputTimes).toBeGreaterThan(rust.indexOf("name: Build patched WASI sysroot"));
  expect(rust.indexOf("bun scripts/quality-input-times.ts")).toBeLessThan(rust.indexOf("bun run quality --native"));
});

test("toolchain and preflight changes cannot restore an incompatible native cache", () => {
  const keys = rust.split("\n").filter(line => /(?:key|restore-keys): native-v/.test(line));
  expect(keys).toHaveLength(2);
  for (const key of keys) {
    for (const input of ["jsc/wasi-jsc.cmake", "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh"]) {
      expect(key.slice(0, key.indexOf(" }}-", key.indexOf("hashFiles")))).toContain(`'${input}'`);
    }
  }
  expect(keys[0]).toContain("hashFiles('crates/**', 'tests/fixtures/runtime-proc-spawn-requests.json')");
});

test("crypto declares the toolchain and CMake preflight as Cargo build inputs", () => {
  const build = readFileSync(new URL("../crates/bunwasm-crypto-sys/build.rs", import.meta.url), "utf8");
  expect(build).toContain('println!("cargo:rerun-if-changed=../../jsc/wasi-jsc.cmake")');
  expect(build).toContain('println!("cargo:rerun-if-changed={}", guard.display())');
  const times = readFileSync(new URL("./quality-input-times.ts", import.meta.url), "utf8");
  expect(times).toContain('"jsc/wasi-jsc.cmake"');
  expect(times).toContain('"tests/fixtures/runtime-proc-spawn-requests.json"');
});

test("merged main keeps its CMake and package identity checks with one owner each", () => {
  expect(workflow.match(/bun test scripts\/cmake-cache.test.ts/g)).toHaveLength(1);
  expect(workflow.match(/bun test scripts\/node-fs-readv.test.ts scripts\/node-fs-runtime-proc.test.ts scripts\/browser-build.test.ts/g)).toHaveLength(1);
  expect(workflow.match(/^  rust:$/gm)).toHaveLength(1);
  expect(workflow).not.toContain("continue-on-error");
});
