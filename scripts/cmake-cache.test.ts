import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guard = join(import.meta.dir, "check-cmake-cache.cmake");
function preflight(build: string, overrides: Record<string, string> = {}) {
  const inputs = { BUILD_DIR: build, EXPECTED_C: "/usr/bin/cc", EXPECTED_CXX: "/usr/bin/c++", EXPECTED_SYSTEM: "native", ...overrides };
  return Bun.spawnSync(["cmake"].concat(Object.entries(inputs).map(([key, value]) => `-D${key}=${value}`), ["-P", guard]), { stdout: "pipe", stderr: "pipe" });
}

// Every fixture owns one tiny CMake source/build tree and synchronous compiler probes.
// No project build, downloaded inputs, daemon or shared cache is created or modified.
function fixture(run: (build: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-cmake-cache-"));
  try {
    const source = join(root, "source"), build = join(root, "build");
    mkdirSync(source);
    writeFileSync(join(source, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(cache_fixture C CXX)\nadd_library(c STATIC fixture.c)\nadd_library(cxx STATIC fixture.cc)\n");
    writeFileSync(join(source, "fixture.c"), "int c_fixture(void) { return 1; }\n");
    writeFileSync(join(source, "fixture.cc"), "int cxx_fixture() { return 2; }\n");
    const configured = Bun.spawnSync(["cmake", "-S", source, "-B", build, "-G", "Ninja", "-DCMAKE_C_COMPILER=/usr/bin/cc", "-DCMAKE_CXX_COMPILER=/usr/bin/c++"], { stdout: "pipe", stderr: "pipe" });
    expect(configured.exitCode, configured.stderr.toString()).toBe(0);
    run(build);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function refuseUnchanged(build: string, overrides: Record<string, string>, diagnostic: string) {
  const cache = join(build, "CMakeCache.txt"), rules = join(build, "CMakeFiles/rules.ninja");
  const beforeCache = readFileSync(cache), beforeRules = readFileSync(rules);
  const result = preflight(build, overrides);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("CMake toolchain mismatch");
  const message = result.stderr.toString().replaceAll(/\s+/g, " ");
  expect(message).toContain(diagnostic);
  expect(message).toContain("Choose a fresh build directory");
  expect(readFileSync(cache)).toEqual(beforeCache);
  expect(readFileSync(rules)).toEqual(beforeRules);
}

test("CMake preflight allows fresh directories and matching native caches without modifying them", () => {
  fixture(build => {
    expect(preflight(join(build, "not-created")).exitCode).toBe(0);
    const before = readFileSync(join(build, "CMakeCache.txt"));
    expect(preflight(build).exitCode).toBe(0);
    expect(readFileSync(join(build, "CMakeCache.txt"))).toEqual(before);
  });
});

test("a genuinely native-configured cache fails before WASI reconfiguration", () => {
  fixture(build => {
    // Keep compiler paths identical to isolate the target-system check from compiler identity.
    refuseUnchanged(build, { EXPECTED_SYSTEM: "WASI", EXPECTED_PROCESSOR: "wasm32", EXPECTED_TARGET: "wasm32-wasip1" }, "requested WASI");
  });
});

test("CMake preflight rejects changed C and C++ compiler identities", () => {
  fixture(build => {
    for (const language of ["C", "CXX"]) {
      refuseUnchanged(build, { [`EXPECTED_${language}`]: process.execPath }, `${language} compiler is`);
    }
  });
});

test("CMake preflight rejects changed target triples even with matching compiler and system", () => {
  fixture(build => { refuseUnchanged(build, { EXPECTED_TARGET: "wasm32-wasip1" }, "compiler targets are"); });
});

test("CMake preflight checks every compiler rule rather than accepting one matching target", () => {
  fixture(build => {
    const path = join(build, "CMakeFiles/rules.ninja");
    const rules = readFileSync(path, "utf8");
    // Mutate the real generated rules only to exercise mixed-target metadata.
    const targets = rules.replaceAll(/(  command = [^\n]*?)( \$DEFINES)/g, "$1 --target=wasm32-wasip1$2");
    expect(targets).not.toBe(rules);
    writeFileSync(path, targets);
    expect(preflight(build, { EXPECTED_TARGET: "wasm32-wasip1" }).exitCode).toBe(0);
    writeFileSync(path, targets.replace(" --target=wasm32-wasip1", ""));
    refuseUnchanged(build, { EXPECTED_TARGET: "wasm32-wasip1" }, "compiler targets are");
  });
});

test("CMake preflight rejects changed target processors and missing sysroots", () => {
  fixture(build => {
    refuseUnchanged(build, { EXPECTED_PROCESSOR: "wasm32" }, "processor is");
    refuseUnchanged(build, { EXPECTED_SYSROOT: build }, "missing configured sysroot");
  });
});

test("CMake preflight refuses absent compiler rules instead of treating them as native", () => {
  fixture(build => {
    writeFileSync(join(build, "CMakeFiles/rules.ninja"), "# incomplete generated rules\n");
    refuseUnchanged(build, {}, "missing C/C++ compiler command rules");
  });
});

test("CMake preflight fails closed on incomplete compiler metadata", () => {
  fixture(build => {
    const directory = readdirSync(join(build, "CMakeFiles")).find(name => /^\d+\.\d+\.\d+$/.test(name));
    expect(directory).toBeDefined();
    rmSync(join(build, "CMakeFiles", directory!, "CMakeCCompiler.cmake"));
    refuseUnchanged(build, {}, "missing compiler/target metadata");
  });
});
