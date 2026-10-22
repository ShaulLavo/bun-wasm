import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("CMake preflight has one always-on lightweight owner, independent of native selection", () => {
  expect(quality).toContain("run: bun test scripts/cmake-cache.test.ts");
  expect(quality).toContain("sudo apt-get install -y cmake ninja-build g++");
  expect(quality).not.toMatch(/^\s+(?:if|needs):/m);
  expect(rust).not.toContain("scripts/cmake-cache.test.ts");
});

for (const { job, install } of [
  { job: "web", install: "bunx playwright install --with-deps chromium webkit" },
  { job: "browser-process", install: "bunx playwright install --with-deps ${{ matrix.browser }}" },
]) {
  test(`${job} selects the existing HTTPS apt mirrors before installing browsers`, () => {
    const section = (workflow.split(`\n  ${job}:\n`)[1] ?? "").split(/\n  \S/)[0] ?? "";
    const step = section.match(/      - name: Use Ubuntu HTTPS archives for browser dependencies\n        run: \|\n((?:          .*\n)+)/);
    if (!step?.[1]) throw new Error("configure apt transport before installing browser dependencies");
    const command = step[1];
    expect(section).toContain("timeout-minutes: 10");
    expect(section).toContain(`run: ${install}`);
    expect(section.indexOf(command)).toBeLessThan(section.indexOf(install));
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-apt-"));
    try {
      const mirrors = join(directory, "apt-mirrors.txt");
      const fallbacks = "https://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n";
      const unrelated = "https://azure.archive.ubuntu.com/ubuntu/\tpriority:4\nhttp://azureXarchiveXubuntuXcom/ubuntu/\tpriority:5\n# http://azure.archive.ubuntu.com/ubuntu/\n";
      const preserved = fallbacks + unrelated;
      writeFileSync(mirrors, "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n" + preserved);
      const run = command.replaceAll("sudo ", "").replaceAll("/etc/apt/apt-mirrors.txt", mirrors);
      const result = spawnSync("bash", ["-euc", run], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readFileSync(mirrors, "utf8")).toBe(preserved);
      expect(spawnSync("bash", ["-euc", run]).status).toBe(0);
      expect(readFileSync(mirrors, "utf8")).toBe(preserved);
      writeFileSync(mirrors, "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n");
      expect(spawnSync("bash", ["-euc", run]).status).not.toBe(0);
      rmSync(mirrors);
      expect(spawnSync("bash", ["-euc", run]).status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
