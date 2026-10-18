import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real compiler identification can exceed Bun's 5-second unit-test budget on CI.
setDefaultTimeout(30_000);
const timeoutWrapper = join(import.meta.dir, "run-with-timeout.mts");
const guard = join(import.meta.dir, "check-cmake-cache.cmake");
function preflight(build: string, overrides: Record<string, string> = {}) {
  const inputs = { BUILD_DIR: build, EXPECTED_C: "/usr/bin/cc", EXPECTED_CXX: "/usr/bin/c++", EXPECTED_SYSTEM: "native", EXPECTED_TOOLCHAIN_FILE: "", ...overrides };
  return Bun.spawnSync(["cmake"].concat(Object.entries(inputs).map(([key, value]) => `-D${key}=${value}`), ["-P", guard]), { stdout: "pipe", stderr: "pipe" });
}

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
  const beforeCache = readFileSync(cache), beforeRules = readFileSync(rules), beforeFiles = retainedFiles(build);
  const result = preflight(build, overrides);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("CMake toolchain mismatch");
  const message = result.stderr.toString().replaceAll(/\s+/g, " ");
  expect(message).toContain(diagnostic);
  expect(message).toContain("Choose a fresh build directory");
  expect(readFileSync(cache)).toEqual(beforeCache);
  expect(readFileSync(rules)).toEqual(beforeRules);
  expect(retainedFiles(build)).toEqual(beforeFiles);
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
  for (const tool of [join(bin, "systemd-run"), join(bin, "ninja"), join(sdk, "bin/clang"), join(sdk, "bin/clang++")]) {
    writeFileSync(tool, guardTool);
    chmodSync(tool, 0o755);
  }
  writeFileSync(join(bin, "wasm-opt"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "wasm-opt"), 0o755);
  const args = ["bash", join(import.meta.dir, "..", entry)];
  if (entry.startsWith("scripts/")) args.push(join(build, "../source"), build);
  const cachePath = join(build, "CMakeCache.txt");
  const cache = existsSync(cachePath) ? readFileSync(cachePath) : null;
  const rules = readFileSync(join(build, "CMakeFiles/rules.ninja"));
  const before = retainedFiles(build);
  const result = Bun.spawnSync(args, {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WASI_SDK_PATH: sdk, JSC_BUILD_DIR: jsc, BUN_WASM_SYSROOT: root, CAGE: "", CMAKE_PREFLIGHT_MARKER: marker, WASM_TOOLS: join(root, "tools") },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("CMake toolchain mismatch");
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(jsc, "shim"))).toBe(false);
  expect(existsSync(cachePath)).toBe(cache !== null);
  if (cache !== null) expect(readFileSync(cachePath)).toEqual(cache);
  expect(readFileSync(join(build, "CMakeFiles/rules.ninja"))).toEqual(rules);
  expect(retainedFiles(build)).toEqual(before);
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

function retainedFiles(build: string) {
  return new Map(readdirSync(build, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name);
      return [path, readFileSync(path)];
    }));
}

test("deleted CMake caches reject retained native output before any build entrypoint work", () => {
  fixture(build => {
    rmSync(join(build, "CMakeCache.txt"));
    const before = retainedFiles(build);
    const result = preflight(build);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing CMakeCache.txt");
    expect(retainedFiles(build)).toEqual(before);
    for (const entry of ["jsc/configure.sh", "jsc/build.sh", "scripts/real-runtime-network-tls.sh"]) {
      wasiEntryPoint(build, entry);
    }
  });
});

test("build-only preflight and JSC reject fresh directories without creating build output", () => {
  fixture(build => {
    const fresh = join(build, "not-created");
    expect(preflight(fresh, { REQUIRE_CONFIGURED: "ON" }).exitCode).not.toBe(0);
    const jsc = join(build, "not-created-jsc");
    const result = Bun.spawnSync(["bash", join(import.meta.dir, "../jsc/build.sh")], {
      env: { ...process.env, JSC_BUILD_DIR: jsc }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("missing CMakeCache.txt");
    expect(existsSync(jsc)).toBe(false);
    expect(existsSync(fresh)).toBe(false);
  });
});

function wasiFixture(run: (build: string, inputs: Record<string, string>) => void, configure: (root: string) => string[] = () => []) {
  let inputs: Record<string, string> = {};
  fixture(build => run(build, inputs), root => {
    const sdk = process.env.WASI_SDK_PATH ?? "/work/cache/wasm-tools/wasi-sdk";
    const c = existsSync(join(sdk, "bin/clang")) ? join(sdk, "bin/clang") : "/usr/bin/clang";
    const cxx = existsSync(join(sdk, "bin/clang++")) ? join(sdk, "bin/clang++") : "/usr/bin/clang++";
    const sysroot = process.env.BUN_WASM_SYSROOT ?? join(root, "sysroot with spaces");
    if (!existsSync(sysroot)) mkdirSync(sysroot, { recursive: true });
    const toolchain = join(root, "wasi.cmake");
    writeFileSync(toolchain, `set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER "${c}")
set(CMAKE_CXX_COMPILER "${cxx}")
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_SYSROOT "${sysroot}" CACHE PATH "fixture sysroot")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
`);
    inputs = { EXPECTED_C: c, EXPECTED_CXX: cxx, EXPECTED_SYSTEM: "WASI", EXPECTED_PROCESSOR: "wasm32", EXPECTED_TARGET: "wasm32-wasip1", EXPECTED_SYSROOT: sysroot, EXPECTED_TOOLCHAIN_FILE: toolchain };
    return [`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`].concat(configure(root));
  });
}

test("matching real WASI compiler commands are accepted without changing retained files", () => {
  wasiFixture((build, inputs) => {
    const before = retainedFiles(build);
    const result = preflight(build, inputs);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(retainedFiles(build)).toEqual(before);
  });
});

function refuseLanguageFlags(flag: string) {
  wasiFixture((build, inputs) => {
    refuseUnchanged(build, inputs, flag.includes("target") ? "compiler target" : "sysroot");
  }, () => [`-DCMAKE_C_FLAGS=${flag}`, `-DCMAKE_CXX_FLAGS=${flag}`]);
}

for (const flag of ["--target=wasm64-unknown-unknown", "-target wasm64-unknown-unknown", '--sysroot="/"', "-isysroot /"]) {
  test(`real CMake language flags cannot override the WASI toolchain with ${flag}`, () => refuseLanguageFlags(flag));
}

function refusePropertyFlags(kind: string, flag: string) {
  wasiFixture((build, inputs) => {
    refuseUnchanged(build, inputs, flag.includes("target") ? "wasm64-unknown-unknown" : "sysroot");
  }, root => propertyFlags(root, kind, flag));
}

function propertyFlags(root: string, kind: string, flag: string) {
  if (kind === "configuration") return ["-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_C_FLAGS_RELEASE=${flag}`, `-DCMAKE_CXX_FLAGS_RELEASE=${flag}`];
  if (kind === "linker configuration") return ["-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_EXE_LINKER_FLAGS_RELEASE=${flag}`];
  const path = join(root, "source/CMakeLists.txt");
  const operation = kind === "target compile" ? "target_compile_options" : "target_link_options";
  writeFileSync(path, readFileSync(path, "utf8") + `${operation}(executable PRIVATE "${flag}")\n`);
  return [];
}

for (const kind of ["configuration", "linker configuration", "target compile", "target link"]) {
  test(`real CMake ${kind} options cannot override the WASI target`, () => refusePropertyFlags(kind, "--target=wasm64-unknown-unknown"));
  test(`real CMake ${kind} options cannot override the WASI sysroot`, () => refusePropertyFlags(kind, "--sysroot=/"));
}

test("CMake response-file compile flags cannot override the WASI target", () => {
  wasiFixture((build, inputs) => {
    expect(readFileSync(join(build, "CMakeFiles/rules.ninja"), "utf8")).toContain("rspfile_content");
    refuseUnchanged(build, inputs, "wasm64-unknown-unknown");
  }, () => ["-DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON", "-DCMAKE_C_FLAGS=--target=wasm64-unknown-unknown", "-DCMAKE_CXX_FLAGS=--target=wasm64-unknown-unknown"]);
});
