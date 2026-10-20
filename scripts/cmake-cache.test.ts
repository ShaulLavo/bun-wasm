import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real compiler identification can exceed Bun's 5-second unit-test budget on CI.
// Its independent process-group deadline also tears down compiler descendants.
setDefaultTimeout(30_000);
const timeoutWrapper = join(import.meta.dir, "run-with-timeout.mts");
const guard = join(import.meta.dir, "check-cmake-cache.cmake");
function preflight(build: string, overrides: Record<string, string> = {}) {
  const inputs = { BUILD_DIR: build, EXPECTED_C: "/usr/bin/cc", EXPECTED_CXX: "/usr/bin/c++", EXPECTED_SYSTEM: "native", EXPECTED_TOOLCHAIN_FILE: "", ...overrides };
  return Bun.spawnSync(["cmake"].concat(Object.entries(inputs).map(([key, value]) => `-D${key}=${value}`), ["-P", guard]), { stdout: "pipe", stderr: "pipe" });
}

// Every fixture owns one tiny CMake source/build tree and synchronous compiler probes.
// No project build, downloaded inputs, daemon or shared cache is created or modified.
function fixture(run: (build: string) => void, configure: (root: string) => string[] = () => []) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-cmake-cache-"));
  try {
    const source = join(root, "source"), build = join(root, "build");
    mkdirSync(source);
    writeFileSync(join(source, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\nproject(cache_fixture C CXX)\nadd_library(c STATIC fixture.c)\nadd_library(cxx STATIC fixture.cc)\nadd_executable(executable fixture.c)\n");
    writeFileSync(join(source, "fixture.c"), "int c_fixture(void) { return 1; }\nint main(void) { return 0; }\n");
    writeFileSync(join(source, "fixture.cc"), "int cxx_fixture() { return 2; }\n");
    const configured = Bun.spawnSync(["node", timeoutWrapper, "15", "cmake", "-S", source, "-B", build, "-G", "Ninja", "-DCMAKE_C_COMPILER=/usr/bin/cc", "-DCMAKE_CXX_COMPILER=/usr/bin/c++"].concat(configure(root)), { stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGTERM" });
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

function wasiEntryPoint(build: string, entry: string) {
  const root = join(build, "..", entry.replaceAll("/", "_"));
  const bin = join(root, "bin"), sdk = join(root, "sdk"), jsc = join(root, "jsc");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(sdk, "bin"), { recursive: true });
  mkdirSync(join(jsc, "build"), { recursive: true });
  symlinkSync(build, join(jsc, "build/jsc"), "dir");
  const marker = join(root, "unexpected-build"), guardTool = "#!/bin/sh\nprintf 'unexpected build\\n' >> \"$CMAKE_PREFLIGHT_MARKER\"\nexit 91\n";
  for (const tool of [join(bin, "systemd-run"), join(sdk, "bin/clang"), join(sdk, "bin/clang++")]) {
    writeFileSync(tool, guardTool);
    chmodSync(tool, 0o755);
  }
  writeFileSync(join(bin, "wasm-opt"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "wasm-opt"), 0o755);
  const args = ["bash", join(import.meta.dir, "..", entry)];
  if (entry.startsWith("scripts/")) args.push(join(build, "../source"), build);
  const cache = readFileSync(join(build, "CMakeCache.txt")), rules = readFileSync(join(build, "CMakeFiles/rules.ninja"));
  const result = Bun.spawnSync(args, {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WASI_SDK_PATH: sdk, JSC_BUILD_DIR: jsc, BUN_WASM_SYSROOT: root, CAGE: "", CMAKE_PREFLIGHT_MARKER: marker },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("CMake toolchain mismatch");
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(jsc, "shim"))).toBe(false);
  expect(readFileSync(join(build, "CMakeCache.txt"))).toEqual(cache);
  expect(readFileSync(join(build, "CMakeFiles/rules.ninja"))).toEqual(rules);
}

test("configure and build entry points refuse native caches before shim, configure or Ninja work", () => {
  fixture(build => {
    for (const entry of ["jsc/configure.sh", "jsc/build.sh", "scripts/real-runtime-network-tls.sh"]) {
      wasiEntryPoint(build, entry);
    }
  });
});

test("CMake preflight requires the configured toolchain file to exist and match the requested file", () => {
  fixture(build => {
    const toolchain = join(build, "../toolchain.cmake"), other = join(build, "../other.cmake");
    writeFileSync(other, "# another toolchain\n");
    expect(preflight(build, { EXPECTED_TOOLCHAIN_FILE: toolchain }).exitCode).toBe(0);
    refuseUnchanged(build, {}, "requested native defaults");
    refuseUnchanged(build, { EXPECTED_TOOLCHAIN_FILE: other }, "toolchain file is");
    rmSync(toolchain);
    refuseUnchanged(build, { EXPECTED_TOOLCHAIN_FILE: toolchain }, "toolchain file is missing");
  }, root => {
    const toolchain = join(root, "toolchain.cmake");
    writeFileSync(toolchain, "# native fixture toolchain\n");
    return [`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`];
  });
});

test("native CMake caches cannot silently retain a foreign sysroot", () => {
  fixture(build => {
    expect(preflight(build, { EXPECTED_SYSROOT: "/" }).exitCode).toBe(0);
    refuseUnchanged(build, {}, "configured sysroot is /, requested native defaults");
  }, () => ["-DCMAKE_SYSROOT:PATH=/"]);
});

for (const phase of ["COMPILE", "LINK"]) {
  test(`native defaults reject a cached ${phase} sysroot override`, () => {
    fixture(build => {
      refuseUnchanged(build, {}, `configured ${phase} sysroot is /, requested native defaults`);
    }, () => [`-DCMAKE_SYSROOT_${phase}:PATH=/`]);
  });

  test(`a cached ${phase} override cannot bypass the requested patched sysroot`, () => {
    fixture(build => {
      const expected = join(build, "../expected-sysroot");
      expect(readFileSync(join(build, "CMakeFiles/rules.ninja"), "utf8")).toContain("--sysroot=/ ");
      refuseUnchanged(build, { EXPECTED_SYSROOT: expected }, `${phase} sysroot is /, requested`);
    }, root => {
      const expected = join(root, "expected-sysroot");
      mkdirSync(expected);
      // A real configure, with static compiler probes, needs no SDK or system headers.
      return [`-DCMAKE_SYSROOT:PATH=${expected}`, "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY", `-DCMAKE_SYSROOT_${phase}:PATH=/`];
    });
  });

  test(`an empty ${phase} override cannot erase an expected sysroot`, () => {
    fixture(build => {
      refuseUnchanged(build, { EXPECTED_SYSROOT: "/" }, `missing configured ${phase} sysroot`);
    }, () => ["-DCMAKE_SYSROOT:PATH=/", `-DCMAKE_SYSROOT_${phase}:PATH=`]);
  });
}

test("matching explicit compile and link sysroots remain reusable", () => {
  fixture(build => {
    expect(preflight(build, { EXPECTED_SYSROOT: "/" }).exitCode).toBe(0);
  }, () => ["-DCMAKE_SYSROOT:PATH=/", "-DCMAKE_SYSROOT_COMPILE:PATH=/", "-DCMAKE_SYSROOT_LINK:PATH=/"]);
});
