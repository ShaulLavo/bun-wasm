import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { discoverChecks, automaticChecks, checkCommand, selectChecks } from "./test-checks";
import { oldSelections, proveCheckMigration } from "./migrations/discover-checks";
import { qualityGates } from "./quality";
import { inBatches, missingPackages, parseArchives, planArchives, prefetchArchive } from "../web/scripts/ci-browser-deps";

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
  expect(rust).toContain("restore-keys: |\n            native-v");
  expect(rust).not.toContain("Swatinem/rust-cache");
  expect(rust).toContain("bun run quality --native");
  expect(rust.match(/cargo test /g)).toHaveLength(1);
  expect(rust).toContain("--lib modules::tests::host_");
});

test("native fixture smoke selects the typed runtime behavior without another build", () => {
  expect(rust.match(/bun scripts\/test-checks\.ts native/g)).toHaveLength(1);
  const command = checkCommand("native");
  expect(command).toEqual(["bash", join(import.meta.dir, "test.sh"), "--no-build"].concat(selectChecks("native").map(path => path.slice("tests/fixtures/".length))));
  const baseline = oldSelections().native.toSorted().map(path => path.slice("tests/fixtures/".length));
  expect(command.slice(3).filter(name => baseline.includes(name))).toEqual(baseline);
  expect(rust).toContain('BUN_WASM_LAUNCHER="$CARGO_TARGET_DIR/release/bun-wasm" bun tests/install/package-options.ts');
  expect(rust).toContain('BUN_WASM_LAUNCHER="$CARGO_TARGET_DIR/release/bun-wasm" bun tests/install/root-overrides.ts');
  expect(rust.match(/cargo build[^\n]*--target wasm32-wasip1[^\n]*-p bunwasm-cli/g) ?? []).toHaveLength(0);
  expect(rust.match(/"\$GUEST_CARGO" build[^\n]*--target wasm32-wasip1[^\n]*-p bunwasm-cli/g)).toHaveLength(1);
});

test("every migrated selection retains one blocking owner and the original local runtime set", () => {
  expect(proveCheckMigration().deduplicated).toHaveLength(7);
  expect(selectChecks("cmake")).toEqual(["scripts/cmake-cache.test.ts"]);
  const checks = discoverChecks().map(check => check.path).concat(automaticChecks().map(check => check.path));
  expect(new Set(checks).size).toBe(checks.length);
  expect(selectChecks("quality")).toContain("scripts/runtime-ts-small.test.ts");
  expect(selectChecks("web")).toContain("scripts/runtime-sqlite.test.ts");
  expect(selectChecks("runtime")).not.toContain("scripts/runtime-emission.test.ts");
  expect(workflow.match(/run: bash \.\.\/scripts\/test-web-host\.sh --unit/g)).toHaveLength(1);
  expect(quality.match(/run: bun run quality --javascript/g)).toHaveLength(1);
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

test("the full-key native fallback rejects incompatible toolchain and preflight inputs", () => {
  const keys = rust.split("\n").filter(line => /native-v4-/.test(line));
  expect(keys).toHaveLength(3);
  for (const key of keys) {
    for (const input of ["jsc/wasi-jsc.cmake", "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh"]) {
      expect(key.slice(0, key.indexOf(" }}-", key.indexOf("hashFiles")))).toContain(`'${input}'`);
    }
  }
  expect(keys[0]).toContain("hashFiles('crates/**', 'tests/fixtures/runtime-proc-spawn-requests.json', 'scripts/quality*.ts')");
});

test("the refined Cargo cache keeps Cargo inputs and leaves JSC-only inputs to the JSC layer", () => {
  const cargoKeys = rust.split("\n").filter(line => /native-cargo-v2-/.test(line));
  expect(cargoKeys).toHaveLength(3);
  for (const key of cargoKeys) {
    expect(key).toContain("scripts/build-wasi-sysroot.ts");
    expect(key).toContain("jsc/wasi-jsc.cmake");
    expect(key).toContain("scripts/check-cmake-cache.cmake");
    expect(key).not.toContain("scripts/check-wasi-cmake-cache.sh");
    expect(key).not.toContain("scripts/ci-binaryen.ts");
  }
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-matched-key == ''");
  expect(rust).toContain("steps.native-cargo-cache.outputs.cache-matched-key == '' && steps.native-cache.outputs.cache-hit != 'true'");
  expect(rust).toContain("JSC_ENGINE_BUILD_DIR=$RUNNER_TEMP/jsc/engine");
  expect(rust).toContain("key: jsc-prebuild-v2-");
  expect(rust).toContain("key: jsc-cargo-v2-");
  expect(rust).toContain("'scripts/ci-binaryen.ts'");
  expect(rust).toContain("'crates/**'");
  for (const input of [
    "scripts/build-engine-jsc.sh", "scripts/build-bun-core.sh", "scripts/build-engine-quickjs.sh", "scripts/build.sh",
    "scripts/quickjs-core-exports.txt", "tests/linker/**", "scripts/src/engine-explicit-init.ts", "scripts/src/engine-init.c",
    "scripts/guest-core-receipt.ts", "scripts/guest-engine-receipt.ts",
  ]) expect(rust).toContain(`'${input}'`);
  expect(rust).not.toContain("scripts/engine-producer.test.ts");
  expect(rust).not.toContain("scripts/src/engine-explicit-init.test.ts");
});

type CacheFiles = Readonly<Record<string, string>>;

function nativeKeyTemplates(namespace: string) {
  const lines = rust.split("\n").filter(line => line.trim().startsWith(`${namespace}-`) || line.trim().startsWith(`key: ${namespace}-`));
  const [primary, prefix, save] = lines.map(line => line.trim().replace(/^key: /, ""));
  if (!primary || !prefix || !save || lines.length !== 3) throw new Error(`Missing cache keys for ${namespace}`);
  return { primary, prefix, save };
}

function matchingCachePaths(patterns: readonly string[], paths: Iterable<string>): string[] {
  const included = patterns.filter(pattern => !pattern.startsWith("!")).map(pattern => new Bun.Glob(pattern));
  const excluded = patterns.filter(pattern => pattern.startsWith("!")).map(pattern => new Bun.Glob(pattern.slice(1)));
  return Array.from(paths).sort().filter(path => included.some(pattern => pattern.match(path)) && !excluded.some(pattern => pattern.match(path)));
}

function fixtureHash(expression: string, files: CacheFiles): string {
  const paths = matchingCachePaths(Array.from(expression.matchAll(/'([^']+)'/g), match => match[1]!), Object.keys(files));
  if (paths.length === 0) return "";
  const digest = createHash("sha256");
  for (const path of paths) digest.update(createHash("sha256").update(files[path]!).digest());
  return digest.digest("hex");
}

function fixtureCacheKey(template: string, files: CacheFiles, image = "20261012.334.1"): string {
  return template.replace(/\$\{\{ (.*?) \}\}/g, (_, expression: string) => {
    if (expression === "runner.os") return "Linux";
    if (expression === "runner.arch") return "X64";
    if (expression === "steps.host-tools.outputs.hash") return image;
    if (expression === "steps.native-inputs.outputs.hash") return "effective-native-inputs";
    if (expression === "steps.jsc-inputs.outputs.hash") return "effective-jsc-inputs";
    if (!expression.startsWith("hashFiles(")) throw new Error(`Unexpected cache expression: ${expression}`);
    return fixtureHash(expression, files);
  });
}

const nativeCargoNamespace = rust.match(/key: (native-cargo-v\d+)-/)![1]!;

const nativeCacheFiles: CacheFiles = {
  "Cargo.toml": '[workspace.package]\nversion = "0.0.51"',
  "Cargo.lock": 'name = "bunwasm-runtime"\nversion = "0.0.51"',
  "crates/bunwasm-runtime/Cargo.toml": 'version.workspace = true',
  "crates/bunwasm-runtime/src/engine_jsc.rs": "old Rust source",
  "crates/bunwasm-runtime/build.rs": "native compiler flags",
  "crates/bunwasm-cli/build.rs": "CLI Cargo build script",
  "third_party/rquickjs-sys/quickjs/quickjs.c": "QuickJS C source",
  "crates/bunwasm-crypto-sys/c/rsa.c": "native C source",
  "crates/bunwasm-jsc/cpp/helpers.cpp": "JSC Cargo C++ helper",
  ".cargo/config.toml": "SQLite compile flags",
  "rust-toolchain.toml": "nightly-2026-09-15",
  ".github/workflows/ci.yml": workflow,
  "env.sh": "SDK/sysroot environment",
  "bun.lock": "installed sysroot builder identity",
  "scripts/build-wasi-sysroot.ts": "sysroot builder",
  "scripts/build-bun-tools.sh": readFileSync(new URL("./build-bun-tools.sh", import.meta.url), "utf8"),
  "scripts/sync-crypto.sh": "BoringSSL source pin",
  "patches/bun/0001.patch": "upstream patch",
  "third_party/zlib-ng/zlib.h.in": "native header",
  "jsc/wasi-jsc.cmake": "WASI C++ toolchain",
  "scripts/check-cmake-cache.cmake": "CMake preflight",
};

const jscCacheFiles: CacheFiles = {
  ...nativeCacheFiles,
  "scripts/build-bun-core.sh": "common core producer",
  "scripts/build-engine-quickjs.sh": "QuickJS side producer",
  "scripts/build-engine-jsc.sh": "JSC side producer",
  "scripts/build.sh": "QuickJS wrapper",
  "scripts/quickjs-core-exports.txt": "QuickJS core exports",
  "scripts/src/engine-explicit-init.ts": "explicit init transformer",
  "scripts/src/engine-init.c": "engine init helper",
  "scripts/guest-core-receipt.ts": "core receipt",
  "scripts/guest-engine-receipt.ts": "engine receipt",
  "scripts/guest-build-receipt.ts": "guest pair receipt",
  "scripts/jsc-embedding.ts": "JSC embedding receipt",
  "tests/linker/quickjs/explicit-init.ts": "explicit init linker check",
};

function changedCacheFile(path: string, contents = "changed"): CacheFiles {
  return { ...nativeCacheFiles, [path]: contents };
}

function changedJscCacheFile(path: string, contents = "changed"): CacheFiles {
  return { ...jscCacheFiles, [path]: contents };
}

test("native Cargo patch releases and Rust edits restore a previously saved compatible primary", () => {
  const keys = nativeKeyTemplates(nativeCargoNamespace);
  const saved = fixtureCacheKey(keys.save, nativeCacheFiles);
  expect(saved).toBe(fixtureCacheKey(keys.primary, nativeCacheFiles));
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles))).toBe(true);
  for (const path of ["Cargo.toml", "Cargo.lock", "crates/bunwasm-runtime/Cargo.toml", "crates/bunwasm-runtime/src/engine_jsc.rs"]) {
    const files = changedCacheFile(path, nativeCacheFiles[path]!.replaceAll("0.0.51", "0.0.52") + "\nchanged");
    expect(fixtureCacheKey(keys.primary, files)).not.toBe(saved);
    expect(saved.startsWith(fixtureCacheKey(keys.prefix, files))).toBe(true);
    expect(fixtureCacheKey(keys.save, files)).toBe(fixtureCacheKey(keys.primary, files));
  }
  expect(fixtureCacheKey(keys.primary, changedCacheFile(".git/HEAD"))).toBe(saved);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, changedCacheFile(".git/HEAD")))).toBe(true);
});

test("native compatibility changes cannot select the prior Cargo cache", () => {
  const keys = nativeKeyTemplates(nativeCargoNamespace);
  const saved = fixtureCacheKey(keys.save, nativeCacheFiles);
  for (const path of Object.keys(nativeCacheFiles).filter(path => !path.includes("Cargo.") && !path.endsWith("engine_jsc.rs") && !["crates/bunwasm-cli/build.rs", "third_party/rquickjs-sys/quickjs/quickjs.c", "scripts/build-bun-tools.sh", ".github/workflows/ci.yml", "env.sh", "bun.lock"].includes(path))) {
    const files = changedCacheFile(path);
    expect(fixtureCacheKey(keys.primary, files)).not.toBe(saved);
    expect(saved.startsWith(fixtureCacheKey(keys.prefix, files))).toBe(false);
  }
  const sdkChange = changedCacheFile(".github/workflows/ci.yml", workflow.replaceAll("wasi-sdk-34", "wasi-sdk-35"));
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, sdkChange))).toBe(true);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles).replace("effective-native-inputs", "changed-sdk-environment"))).toBe(false);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles, "next-image"))).toBe(false);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles).replace("Linux-X64", "Linux-ARM64"))).toBe(false);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles).replace("Linux-X64", "macOS-X64"))).toBe(false);
});

for (const namespace of [nativeCargoNamespace, "jsc-cargo-v2"]) {
  test(`${namespace} restores compatible dependencies but changes exact identity for audited Cargo source`, () => {
    const keys = nativeKeyTemplates(namespace);
    const saved = fixtureCacheKey(keys.save, nativeCacheFiles);
    for (const path of ["crates/bunwasm-cli/build.rs", "crates/bunwasm-cli/entry-split.c", "third_party/rquickjs-sys/quickjs/quickjs.c"]) {
      const files = changedCacheFile(path);
      expect(fixtureCacheKey(keys.primary, files)).not.toBe(saved);
      expect(saved.startsWith(fixtureCacheKey(keys.prefix, files))).toBe(true);
      expect(fixtureCacheKey(keys.save, files)).toBe(fixtureCacheKey(keys.primary, files));
    }
    for (const path of [".cargo/config.toml", "rust-toolchain.toml", "patches/bun/0001.patch", "third_party/zlib-ng/zlib.h.in", "third_party/rquickjs-sys/build.rs", "third_party/rquickjs-sys/quickjs/quickjs.h", "crates/bunwasm-runtime/build.rs", "crates/bunwasm-crypto-sys/c/rsa.c", "scripts/check-cmake-cache.cmake"]) {
      expect(saved.startsWith(fixtureCacheKey(keys.prefix, changedCacheFile(path)))).toBe(false);
    }
    for (const input of ["effective-native-inputs", "effective-jsc-inputs"]) {
      if (!saved.includes(input)) continue;
      expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles).replace(input, "incompatible-environment"))).toBe(false);
    }
  });
}

test("the source partition cannot reuse old source-containing Cargo prefixes", () => {
  for (const namespace of [nativeCargoNamespace, "jsc-cargo-v2"]) {
    const keys = nativeKeyTemplates(namespace);
    const previous = keys.save.replaceAll(/, '!([^']+)'/g, "");
    expect(previous).not.toBe(keys.save);
    expect(fixtureCacheKey(previous, nativeCacheFiles).startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles))).toBe(false);
  }
});

test("old Cargo-first keys cannot use the new compatibility prefix, and fallback never overlays a match", () => {
  const old = nativeKeyTemplates("native-v4");
  const keys = nativeKeyTemplates(nativeCargoNamespace);
  const oldSaved = fixtureCacheKey(old.save, nativeCacheFiles);
  expect(oldSaved.startsWith(fixtureCacheKey(old.prefix, changedCacheFile("Cargo.lock")))).toBe(false);
  expect(oldSaved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles))).toBe(false);
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-matched-key == ''");
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-hit != 'true'");
  expect(rust).toContain("steps.native-cargo-cache.outputs.cache-matched-key == '' && steps.native-cache.outputs.cache-hit != 'true'");
});

test("JSC prebuild and Cargo caches keep separate authoritative identities", () => {
  const prebuild = nativeCacheContract("jsc-prebuild-cache", "Save the JSC prebuild cache once per input revision");
  const cargo = nativeCacheContract("jsc-cargo-cache", "Save the JSC Cargo cache once per input revision");
  expect(prebuild.primary).toBe(prebuild.save);
  expect(cargo.primary).toBe(cargo.save);
  expect(prebuild.restorePath).toBe("${{ runner.temp }}/jsc/prebuild");
  expect(cargo.restorePath).toBe("${{ runner.temp }}/jsc/engine");
  expect(prebuild.primary).toContain("steps.jsc-inputs.outputs.hash");
  expect(cargo.prefix).toContain("steps.jsc-inputs.outputs.hash");
  expect(cargo.prefix).toContain("steps.native-inputs.outputs.hash");
  expect(prebuild.primary).not.toContain("crates/**");
  expect(cargo.primary).toContain("crates/**");
  expect(rust).not.toContain("steps.jsc-cache");
  expect(rust.indexOf("name: Save the JSC prebuild")).toBeLessThan(rust.indexOf("name: Build native fixtures"));
  expect(rust.indexOf("name: Save the JSC Cargo")).toBeLessThan(rust.indexOf("name: Blocking JSC embedding"));
});

test("JSC Cargo exact identity covers pair producers and receipts without test-only inputs", () => {
  const keys = nativeKeyTemplates("jsc-cargo-v2");
  const saved = fixtureCacheKey(keys.save, jscCacheFiles);
  for (const path of [
    "scripts/build-bun-core.sh", "scripts/build-engine-quickjs.sh", "scripts/build-engine-jsc.sh", "scripts/build.sh",
    "scripts/quickjs-core-exports.txt", "scripts/src/engine-explicit-init.ts", "scripts/guest-core-receipt.ts",
    "scripts/guest-engine-receipt.ts", "scripts/guest-build-receipt.ts", "scripts/jsc-embedding.ts", "tests/linker/quickjs/explicit-init.ts",
  ]) {
    const changed = changedJscCacheFile(path, "changed producer input");
    expect(fixtureCacheKey(keys.primary, changed)).not.toBe(saved);
    expect(fixtureCacheKey(keys.save, changed)).toBe(fixtureCacheKey(keys.primary, changed));
  }
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, changedJscCacheFile("scripts/src/engine-init.c", "changed ABI helper")))).toBe(false);
  for (const path of ["scripts/engine-producer.test.ts", "scripts/src/engine-explicit-init.test.ts"]) {
    expect(fixtureCacheKey(keys.primary, changedJscCacheFile(path, "test-only source"))).toBe(saved);
  }
});

test("crypto declares the toolchain and CMake preflight as Cargo build inputs", () => {
  const build = readFileSync(new URL("../crates/bunwasm-crypto-sys/build.rs", import.meta.url), "utf8");
  expect(build).toContain('println!("cargo:rerun-if-changed=../../jsc/wasi-jsc.cmake")');
  expect(build).toContain('println!("cargo:rerun-if-changed={}", guard.display())');
  const cargoKey = rust.split("\n").find(line => /native-cargo-v2-/.test(line))!;
  expect(cargoKey).toContain("jsc/wasi-jsc.cmake");
  expect(cargoKey).toContain("scripts/check-cmake-cache.cmake");
  const times = readFileSync(new URL("./quality-input-times.ts", import.meta.url), "utf8");
  expect(times).toContain('"jsc/wasi-jsc.cmake"');
  expect(times).toContain('"tests/fixtures/runtime-proc-spawn-requests.json"');
});

test("merged main keeps its CMake and package identity checks with one owner each", () => {
  expect(workflow.match(/bun scripts\/test-checks\.ts cmake/g)).toHaveLength(1);
  expect(workflow.match(/bun scripts\/test-checks\.ts package-extra/g)).toHaveLength(1);
  expect(workflow.match(/^  rust:$/gm)).toHaveLength(1);
  expect(workflow).not.toContain("continue-on-error");
});

test("CMake preflight has one always-on lightweight owner, independent of native selection", () => {
  expect(quality).toContain("run: bun scripts/test-checks.ts cmake");
  expect(quality).toContain("sudo apt-get install -y cmake ninja-build g++");
  expect(quality).not.toMatch(/^ {4}(?:if|needs):/m);
  expect(rust).not.toContain("scripts/cmake-cache.test.ts");
});

for (const { job, install } of [
  { job: "web", install: "bunx playwright install chromium webkit" },
  { job: "browser-process", install: "bunx playwright install ${{ matrix.browser }}" },
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

for (const { job, browsers } of [
  { job: "web", browsers: "chromium webkit" },
  { job: "browser-process", browsers: "${{ matrix.browser }}" },
]) {
  test(`${job} prefetches verified apt archives instead of serial browser dependency downloads`, () => {
    const section = (workflow.split(`\n  ${job}:\n`)[1] ?? "").split(/\n  \S/)[0] ?? "";
    expect(section).toContain(`bun scripts/ci-browser-deps.ts ${browsers}`);
    expect(section).toContain(`bunx playwright install ${browsers}`);
    expect(section).not.toContain("playwright install --with-deps");
    expect(section).toContain("${{ runner.temp }}/browser-apt/*.deb");
    expect(section).not.toContain("~/.cache/ms-playwright");
    expect(section).not.toContain("uses: actions/cache@v4");
    const restore = section.indexOf("uses: actions/cache/restore@v4");
    const setup = section.indexOf(`run: bun scripts/ci-browser-deps.ts ${browsers}`);
    const save = section.indexOf("uses: actions/cache/save@v4");
    const browserInstall = section.indexOf(`run: bunx playwright install ${browsers}`);
    expect(restore).toBeGreaterThan(0);
    expect(restore).toBeLessThan(setup);
    expect(save).toBeGreaterThan(setup);
    expect(save).toBeLessThan(browserInstall);
    expect(section).toContain("if: steps.browser-cache.outputs.cache-hit != 'true'");
    expect(section).toContain("key: ${{ steps.browser-cache.outputs.cache-primary-key }}");
    expect(section).toContain("timeout-minutes: 10");
  });
}

test("browser dependency reports fail closed and retain every missing package", () => {
  expect(missingPackages("All system dependencies are installed.\n")).toEqual([]);
  expect(missingPackages("Missing system dependencies (2):\n  fonts-noto-color-emoji\n  libcodec2-1.2\n")).toEqual(["fonts-noto-color-emoji", "libcodec2-1.2"]);
  expect(() => missingPackages("Missing system dependencies (2):\n  libcodec2-1.2\n")).toThrow("Invalid");
  expect(() => missingPackages("Missing system dependencies (1):\n  --allow-unauthenticated\n")).toThrow("Invalid");
  expect(() => missingPackages("apt simulation failed")).toThrow("Unexpected");
});

test("apt prefetch uses signed-index SHA256 hashes and preserves mirror resolution", () => {
  const hash = "a".repeat(64);
  const uri = "mirror+file:/etc/apt/apt-mirrors.txt/pool/main/a/archive.deb";
  const row = `'${uri}' archive_1.0_amd64.deb 42 SHA256:${hash}`;
  expect(parseArchives(`Reading package lists...\n${row}\n`)).toEqual([{ uri, filename: "archive_1.0_amd64.deb", size: 42, sha256: hash }]);
  expect(parseArchives(row.replace(uri, "https://archive.ubuntu.com/ubuntu/pool/main/a/archive.deb"))).toHaveLength(1);
  expect(() => parseArchives(row.replace("SHA256:", "MD5Sum:"))).toThrow("SHA256");
  expect(() => parseArchives(row.replace("archive_1.0_amd64.deb", "../archive.deb"))).toThrow("SHA256");
  expect(() => parseArchives(row.replace(uri, "http://azure.archive.ubuntu.com/ubuntu/pool/main/a/archive.deb"))).toThrow("transport");
  expect(() => parseArchives(row.replace(" 42 ", " 0 "))).toThrow("size");
});

test("prefetch starts a bounded batch before waiting, unlike serial apt downloads", async () => {
  const started: number[] = [];
  const release: (() => void)[] = [];
  const download = (item: number) => new Promise<void>(resolve => {
    started.push(item);
    release.push(resolve);
  });
  const result = inBatches([1, 2, 3, 4, 5], 3, download);
  expect(started).toEqual([1, 2, 3]);
  for (const resolve of release.splice(0)) resolve();
  await Bun.sleep(0);
  expect(started).toEqual([1, 2, 3, 4, 5]);
  for (const resolve of release) resolve();
  await result;
});

test("failed prefetch waits for active downloads and never starts the next batch", async () => {
  const started: number[] = [];
  let settled = false;
  const download = async (item: number) => {
    started.push(item);
    if (item === 1) throw new Error("hash mismatch");
    await Bun.sleep(5);
    settled = true;
  };
  await expect(inBatches([1, 2, 3], 2, download)).rejects.toThrow("hash mismatch");
  expect(started).toEqual([1, 2]);
  expect(settled).toBe(true);
  await expect(inBatches([], 0, download)).rejects.toThrow("positive concurrency");
});

for (const cached of ["verified archive", "tampered archive", "truncated", "missing"]) {
  test(`apt prefetch verifies ${cached} cache contents before reuse`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-cache-"));
    try {
      const contents = "verified archive";
      const filename = "archive_1.0_amd64.deb";
      const target = join(directory, filename);
      const archive = { uri: "https://example.invalid/archive.deb", filename, size: contents.length, sha256: new Bun.CryptoHasher("sha256").update(contents).digest("hex") };
      if (cached !== "missing") writeFileSync(target, cached);
      if (cached === "tampered archive") expect(cached.length).toBe(archive.size);
      let downloads = 0;
      const download = async () => {
        expect(await Bun.file(target).exists()).toBe(false);
        downloads++;
        writeFileSync(target, contents);
      };
      await prefetchArchive(archive, directory, download);
      expect(downloads).toBe(cached === contents ? 0 : 1);
      expect(readFileSync(target, "utf8")).toBe(contents);
      await prefetchArchive(archive, directory, download);
      expect(downloads).toBe(cached === contents ? 0 : 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("apt prefetch rejects a same-size download with the wrong SHA256", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-cache-"));
  try {
    const filename = "archive_1.0_amd64.deb";
    const contents = "verified archive";
    const archive = { uri: "https://example.invalid/archive.deb", filename, size: contents.length, sha256: new Bun.CryptoHasher("sha256").update(contents).digest("hex") };
    await expect(prefetchArchive(archive, directory, async () => {
      writeFileSync(join(directory, filename), "tampered archive");
    })).rejects.toThrow("APT archive verification failed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const fail of [false, true]) {
  test(`apt plans against an empty archive directory and cleans up on ${fail ? "failure" : "success"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-browser-plan-"));
    try {
      writeFileSync(join(directory, "cached.deb"), "untrusted cache");
      const install = ["install", "-o", `Dir::Cache::archives=${directory}`, "libexample"];
      const run = (args: string[], capture = false) => {
        expect(capture).toBe(true);
        expect(args.slice(0, 2)).toEqual(["--print-uris", "--download-only"]);
        expect(args.slice(2, -2)).toEqual(install);
        const override = args.at(-1) ?? "";
        expect(override).toStartWith("Dir::Cache::archives=");
        const empty = override.slice("Dir::Cache::archives=".length);
        expect(empty).not.toBe(directory);
        expect(readdirSync(empty)).toEqual([]);
        writeFileSync(join(empty, "lock"), "");
        if (fail) throw new Error("apt planning failed");
        return "";
      };
      const plan = planArchives(install, directory, run);
      if (fail) await expect(plan).rejects.toThrow("apt planning failed");
      if (!fail) expect(await plan).toEqual([]);
      expect(readdirSync(directory)).toEqual(["cached.deb"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("package preparation builds once, and non-package installs skip lifecycle builds", () => {
  const adapter = workflow.split("\n  package:\n")[1]!.split("\n  web:\n")[0]!;
  expect(adapter).toContain("run: bun install --frozen-lockfile");
  expect(adapter).not.toContain("run: bun run build");
  expect(quality).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(rust).toContain("bun install --frozen-lockfile --ignore-scripts");
});

test("the WASI lint probe cannot dirty release build timestamps", () => {
  const gates = rust.indexOf("bun run quality --native");
  const restore = rust.indexOf("bun scripts/quality-input-times.ts", gates);
  expect(restore).toBeGreaterThan(gates);
  expect(restore).toBeLessThan(rust.indexOf("cargo test --locked --release", gates));
  expect(restore).toBeLessThan(rust.indexOf("cargo build --release", gates));
});

test("one artifact supplies all process browsers without recompiling fixtures", () => {
  const producer = workflow.split("\n  process-bundles:\n")[1]!.split("\n  browser-process:\n")[0]!;
  const browsers = workflow.split("\n  browser-process:\n")[1]!;
  expect(producer).toContain("bun web/scripts/ci-process-bundles.ts");
  expect(producer).toContain("actions/upload-artifact@v4");
  expect(browsers).toContain("needs: [quality, rust, process-bundles]");
  expect(browsers).toContain("actions/download-artifact@v4");
  expect(browsers).toContain("BUN_WASM_PROCESS_BUNDLES:");
  expect(browsers).toContain("BUN_WASM_RUNTIME_PROC_BUNDLE:");
  expect(browsers).toContain("--frozen-lockfile --linker=isolated");
});

test("Rust build caches follow host tool versions, not the runner image", () => {
  expect(rust).not.toContain("ImageVersion");
  const step = rust.indexOf("name: Identify host build tools");
  expect(step).toBeGreaterThan(rust.indexOf("name: Install native build tools"));
  expect(step).toBeLessThan(rust.indexOf("id: sysroot-cache"));
  expect(rust.match(/steps\.host-tools\.outputs\.hash/g)).toHaveLength(14);
});

test("native cache stays bounded per input revision, and the SDK is not copied per lock", () => {
  expect(rust).toContain("uses: actions/cache/restore@v4\n        id: native-cache");
  expect(rust).toContain("uses: actions/cache/restore@v4\n        id: native-cargo-cache");
  expect(rust.match(/uses: actions\/cache\/save@v4/g)).toHaveLength(9);
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-hit != 'true'");
  expect(rust).not.toContain("github.run_id");
  expect(rust).not.toContain("github.run_attempt");
  const sdkKey = rust.split("\n").find(line => line.includes("key: wasi-sdk-"))!;
  expect(sdkKey).not.toContain("hashFiles");
  expect(sdkKey).not.toContain("steps.host-tools.outputs.hash");
  expect(rust).toContain("path: ${{ env.WASM_TOOLS }}/bun-wasm-sysroot-patched");
});

test("completed producers seed caches before unrelated guest gates", () => {
  const prebuildSave = rust.indexOf("name: Save the JSC prebuild cache");
  const bootstrapSave = rust.indexOf("name: Save the native quality checkpoint");
  const jscCargoSave = rust.indexOf("name: Save the JSC Cargo cache");
  const nativeSave = rust.indexOf("name: Save the refined native Cargo cache");
  expect(prebuildSave).toBeGreaterThan(rust.indexOf("name: Build or verify the JSC prebuild"));
  expect(prebuildSave).toBeLessThan(rust.indexOf("name: Blocking native quality checks"));
  expect(bootstrapSave).toBeGreaterThan(rust.indexOf("name: Blocking native quality checks"));
  expect(prebuildSave).toBeLessThan(rust.indexOf("name: Build native fixtures"));
  expect(bootstrapSave).toBeLessThan(rust.indexOf("name: Build native fixtures"));
  expect(jscCargoSave).toBeGreaterThan(rust.indexOf("name: Build the JSC Cargo guest"));
  expect(jscCargoSave).toBeLessThan(rust.indexOf("bun scripts/jsc-embedding.ts test"));
  expect(nativeSave).toBeGreaterThan(rust.indexOf("bash scripts/build-bun-tools.sh"));
  expect(nativeSave).toBeLessThan(rust.indexOf("test-web-guests.ts quickjs browser"));
  expect(nativeSave).toBeLessThan(rust.indexOf("test-web-guests.ts jsc"));
});

test("split engine producers reuse one common core and retain both pair receipts", () => {
  const native = nativeScript() + workflowString(workflowField(nativeWorkflowStep("name", "Build native fixtures after the cache checkpoint"), "run"));
  expect(native).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  expect(native.match(/CARGO_BUILD_JOBS=2 bash scripts\/build\.sh/g)).toHaveLength(1);
  expect(native).not.toContain("build-bun-core.sh");
  const common = workflowString(workflowField(nativeWorkflowStep("name", "Build the common engine core once"), "run"));
  expect(common).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  expect(common.match(/bash scripts\/build-bun-core\.sh/g)).toHaveLength(1);
  expect(rust.indexOf("name: Build the common engine core once")).toBeLessThan(rust.indexOf("name: Start the JSC Cargo guest build"));
  const jsc = workflowString(workflowField(nativeWorkflowStep("name", "Start the JSC Cargo guest build"), "run"));
  expect(jsc).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  const paths = workflowString(workflowField(nativeWorkflowStep("name", "Configure private JSC build paths"), "run"));
  expect(paths).toContain('JSC_ENGINE_BUILD_DIR=$RUNNER_TEMP/jsc/engine');
  expect(jsc.match(/bash scripts\/build-bun-jsc\.sh/g)).toHaveLength(1);
  expect(rust).toContain("dist/jsc-engine.wasm.engine.json");
  expect(rust).toContain("${{ runner.temp }}/jsc/engine/engine-link.map");
  expect(rust).toContain("dist/*.wasm.engine.json");
});

test("preinstalled native tools skip apt and fallback removes the known slow mirror", () => {
  for (const section of [quality, rust]) {
    expect(section).toContain("if command -v cmake");
    expect(section.indexOf("then exit 0; fi")).toBeLessThan(section.indexOf("sudo apt-get update"));
    expect(section).toContain("/etc/apt/apt-mirrors.txt");
  }
});

test("cold and restored JSC setup install Binaryen before sourcing common.sh", () => {
  const setup = rust.match(/      - name: Install pinned Binaryen\n((?:        .*\n|          .*\n)+)/)?.[0] ?? "";
  expect(setup).toContain("bun scripts/ci-binaryen.ts");
  expect(setup).not.toContain("needs.quality.outputs.jsc");
  expect(setup).not.toContain("cache-hit");
  expect(rust.indexOf(setup)).toBeLessThan(rust.indexOf("name: Build or verify the JSC prebuild"));
});

test("Binaryen remains pinned while runtime tool identity owns JSC reuse", () => {
  const keys = rust.split("\n").filter(line => /key: (?:binaryen-133|native-v4)|^\s+native-v4/.test(line));
  expect(keys).toHaveLength(4);
  expect(rust).toContain("path: ${{ env.WASM_TOOLS }}/binaryen-version_133-x86_64-linux.tar.gz");
  for (const key of keys) expect(key).toContain("'scripts/ci-binaryen.ts'");
  expect(rust).toContain("inputs=$(jsc_inputs_hash)");
  const common = readFileSync(new URL("../jsc/common.sh", import.meta.url), "utf8");
  expect(common).toContain("wasm-opt --version");
  expect(rust.split("\n").filter(line => /native-cargo-v2-/.test(line)).every(line => !line.includes("scripts/ci-binaryen.ts"))).toBe(true);
});

test("source cache runs in real browsers using one source-built host guest", () => {
  const processes = workflow.split("\n  browser-process:\n")[1]!;
  expect(rust).toContain("--no-default-features --features engine-host,bun-build");
  expect(rust).toContain("uses: actions/upload-artifact@v4");
  expect(processes).toContain("uses: actions/download-artifact@v4");
  expect(processes).toContain("needs: [quality, rust, process-bundles]");
  expect(processes).toContain("needs.rust.result == 'skipped'");
  expect(processes).toContain("BUN_WASM_RUNTIME_PROC_SCENARIO: source-cache");
  expect(processes).toContain("BUN_WASM_RUNTIME_PROC_PORT: \"4187\"");
  expect(processes).toContain("bun tests/bun-runtime-proc-browser.ts ${{ matrix.browser }}");
  expect(processes.match(/^    needs:/gm)).toHaveLength(1);
  expect(processes).toContain("needs.process-bundles.result == 'success'");
  const hostBuild = rust.indexOf("name: Build one host-engine guest for real-browser source cache acceptance");
  const save = rust.indexOf("name: Save the refined native Cargo cache once per input revision");
  expect(hostBuild).toBeGreaterThan(-1);
  expect(save).toBeGreaterThan(hostBuild);
});

test("Bun acceptance has one distinct shared producer and no per-browser build", () => {
  const producer = readFileSync(new URL("../web/scripts/ci-process-bundles.ts", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../web/tests/bun-runtime-proc-browser.ts", import.meta.url), "utf8");
  const processes = workflow.split("\n  browser-process:\n")[1]!;
  const acceptance = processes.split("      - name: Real Bun source cache in one Waffle browser runtime\n")[1]!;
  expect(producer).toContain('["supervisor", "runtime-proc", "interrupt", "bun-runtime-proc"]');
  expect(producer).toContain('fixture === "bun-runtime-proc" ? "bun-runtime-proc-main"');
  expect(controller).toContain('await processBundle("bun-runtime-proc", out)');
  expect(controller).not.toContain("buildBrowserEntries");
  expect(acceptance).toContain("BUN_WASM_PROCESS_BUNDLES: ${{ runner.temp }}/process-bundles");
  expect(acceptance).not.toContain("BUN_WASM_RUNTIME_PROC_BUNDLE:");
});

function workflowField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) throw new Error(`Missing workflow field: ${key}`);
  return Reflect.get(value, key);
}

function workflowString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected workflow string");
  return value;
}

function nativeWorkflowStep(key: string, value: string): unknown {
  const parsed: unknown = Bun.YAML.parse(workflow);
  const steps: unknown = workflowField(workflowField(workflowField(parsed, "jobs"), "rust"), "steps");
  if (!Array.isArray(steps)) throw new Error("Expected native steps");
  const matches = steps.filter((item: unknown) => typeof item === "object" && item !== null && key in item && Reflect.get(item, key) === value);
  expect(matches).toHaveLength(1);
  return matches[0];
}

const wasmToolsArchive = "wasm-tools-1.262.0-x86_64-linux.tar.gz";
const wasmToolsSetupName = "Install pinned wasm-tools";

function wasmToolsSetup(): string {
  return workflowString(workflowField(nativeWorkflowStep("name", wasmToolsSetupName), "run"));
}

test("split producer wasm-tools setup is pinned, cached and unconditional before native gates", () => {
  const step = nativeWorkflowStep("name", wasmToolsSetupName);
  expect(step).not.toHaveProperty("if");
  expect(workflowField(step, "shell")).toBe("bash");
  const cache = workflowField(nativeWorkflowStep("id", "wasm-tools-cache"), "with");
  expect(workflowField(cache, "path")).toBe("${{ env.WASM_TOOLS }}/" + wasmToolsArchive);
  expect(workflowField(cache, "key")).toBe("wasm-tools-1.262.0-${{ runner.os }}-${{ runner.arch }}");
  const script = wasmToolsSetup();
  expect(script).toContain(`https://github.com/bytecodealliance/wasm-tools/releases/download/v1.262.0/${wasmToolsArchive}`);
  expect(script).toContain("655b8df67d54c3ef9b52fc237c4e94bbfbb5f5f43825245cb0940a7002a9ed65");
  expect(script).toContain('wasm-tools 1.262.0 (e22db44da 2026-10-13)');
  expect(script.indexOf("sha256sum --check")).toBeLessThan(script.indexOf("tar -xzf"));
  expect(script.indexOf("--version")).toBeLessThan(script.indexOf('>> "$GITHUB_PATH"'));
  expect(rust.indexOf(`name: ${wasmToolsSetupName}`)).toBeLessThan(rust.indexOf(`name: ${prebuildStepName}`));
  for (const path of ["build-bun-core.sh", "build-engine-quickjs.sh"]) {
    expect(readFileSync(join(import.meta.dir, path), "utf8")).toContain("wasm-tools validate");
  }
});

function runWasmToolsSetup(contents?: string) {
  const script = wasmToolsSetup();
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-validator-"));
  try {
    const bin = join(directory, "bin");
    const tools = join(directory, "tools");
    const trace = join(directory, "trace");
    const githubPath = join(directory, "github-path");
    mkdirSync(bin);
    mkdirSync(tools);
    writeFileSync(githubPath, "");
    writeFileSync(join(bin, "curl"), '#!/bin/sh\necho curl >> "$TRACE"\nexit 23\n', { mode: 0o700 });
    writeFileSync(join(bin, "tar"), '#!/bin/sh\necho tar >> "$TRACE"\nexit 29\n', { mode: 0o700 });
    if (contents !== undefined) writeFileSync(join(tools, wasmToolsArchive), contents);
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, WASM_TOOLS: tools, GITHUB_PATH: githubPath, TRACE: trace }, encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, files: readdirSync(tools), path: readFileSync(githubPath, "utf8"), calls: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("wasm-tools cold download failure stops before extraction or PATH publication", () => {
  const result = runWasmToolsSetup();
  expect(result.status).toBe(23);
  expect(result.calls).toBe("curl\n");
  expect(result.files).toEqual([]);
  expect(result.path).toBe("");
});

for (const contents of ["corrupt cached validator", ""]) {
  test(`wasm-tools ${contents ? "corrupt" : "empty"} cache hit fails checksum before extraction or execution`, () => {
    const result = runWasmToolsSetup(contents);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED");
    expect(result.calls).toBe("");
    expect(result.files).toEqual([wasmToolsArchive]);
    expect(result.path).toBe("");
  });
}

function nativeCacheContract(id: string, saveName: string) {
  const restore = nativeWorkflowStep("id", id);
  const save = nativeWorkflowStep("name", saveName);
  const inputs = workflowField(restore, "with");
  return {
    primary: workflowString(workflowField(inputs, "key")),
    prefix: workflowString(workflowField(inputs, "restore-keys")).trim(),
    save: workflowString(workflowField(workflowField(save, "with"), "key")),
    condition: workflowString(workflowField(save, "if")),
    restorePath: workflowField(inputs, "path"),
    savePath: workflowField(workflowField(save, "with"), "path"),
  };
}

function cacheCondition(condition: string, outputs: Readonly<Record<string, string>>, succeeded: boolean, cancelled = false): boolean {
  const explicit = condition.includes("!cancelled()");
  const expression = condition.replace(/^\$\{\{ /, "").replace(/ \}\}$/, "");
  return !cancelled && (succeeded || explicit) && expression.split(" && ").every(clause => {
    if (clause === "!cancelled()") return true;
    const group = /^\((.*)\)$/.exec(clause);
    if (group) return group[1]!.split(" || ").some(option => comparison(option, outputs));
    return comparison(clause, outputs);
  });
}

function comparison(clause: string, outputs: Readonly<Record<string, string>>): boolean {
  const match = /^(steps\.[\w-]+\.outputs\.[\w-]+|needs\.quality\.outputs\.jsc|github\.event_name) (==|!=) '([^']*)'$/.exec(clause);
  if (!match || !(match[1]! in outputs)) throw new Error(`Unsupported cache condition: ${clause}`);
  return match[2] === "==" ? outputs[match[1]!] === match[3] : outputs[match[1]!] !== match[3];
}

test("parsed native cache guards distinguish exact, prefix and missing restores after successful gates", () => {
  const fallback = workflowString(workflowField(nativeWorkflowStep("id", "native-cache"), "if"));
  const saves = [
    "Save the JSC prebuild cache once per input revision", "Save the JSC Cargo cache once per input revision",
    "Save the refined native Cargo cache once per input revision", "Save the native quality checkpoint",
  ].map(name => workflowString(workflowField(nativeWorkflowStep("name", name), "if")));
  const states = [
    { v2: "exact", v4: "not-run", expected: [false, false, false] },
    { v2: "prefix", v4: "not-run", expected: [false, true, false] },
    { v2: "miss", v4: "exact", expected: [true, true, false] },
    { v2: "miss", v4: "prefix", expected: [true, true, true] },
    { v2: "miss", v4: "miss", expected: [true, true, true] },
  ];
  for (const { v2, v4, expected } of states) {
    const outputs = {
      "steps.native-cargo-cache.outputs.cache-matched-key": v2 === "miss" ? "" : `saved-${v2}`,
      "steps.native-cargo-cache.outputs.cache-hit": String(v2 === "exact"),
      "steps.native-cache.outputs.cache-hit": v4 === "not-run" ? "" : String(v4 === "exact"),
      "steps.jsc-prebuild-cache.outputs.cache-hit": "false",
      "steps.jsc-cargo-cache.outputs.cache-hit": "false",
      "steps.jsc-cargo-cache.outputs.cache-matched-key": "",
      "github.event_name": "push",
      "needs.quality.outputs.jsc": "true",
      "steps.native-producers.outputs.native-ready": "true",
      "steps.jsc-producer.outputs.jsc-ready": "true",
    };
    expect([fallback, saves[2]!, saves[3]!].map(condition => cacheCondition(condition, outputs, true))).toEqual(expected);
    expect(saves.map(condition => cacheCondition(condition, outputs, false))).toEqual([true, false, false, expected[2]!]);
    expect(saves.map(condition => cacheCondition(condition, outputs, true, true))).toEqual([false, false, false, false]);
    const incomplete = { ...outputs, "steps.native-producers.outputs.native-ready": "", "steps.jsc-producer.outputs.jsc-ready": "" };
    expect(saves.map(condition => cacheCondition(condition, incomplete, false))).toEqual([false, false, false, false]);
    assertJscSaveSelection(saves.slice(0, 2), outputs);
    // Pull requests keep cold seeds but skip re-saving a compatible restore.
    const pullRequest = { ...outputs, "github.event_name": "pull_request" };
    expect(cacheCondition(saves[2]!, pullRequest, true)).toBe(expected[1]! && v2 === "miss");
    expect(cacheCondition(saves[1]!, pullRequest, true)).toBe(true);
    expect(cacheCondition(saves[1]!, { ...pullRequest, "steps.jsc-cargo-cache.outputs.cache-matched-key": "saved-prefix" }, true)).toBe(false);
    expect(cacheCondition(saves[1]!, { ...outputs, "steps.jsc-cargo-cache.outputs.cache-matched-key": "saved-prefix" }, true)).toBe(true);
  }
});

function assertJscSaveSelection(conditions: readonly string[], outputs: Readonly<Record<string, string>>) {
  expect(conditions.map(condition => cacheCondition(condition, outputs, true))).toEqual([true, true]);
  const nativeOnly = { ...outputs, "needs.quality.outputs.jsc": "false" };
  expect(conditions.map(condition => cacheCondition(condition, nativeOnly, true))).toEqual([true, false]);
  const incomplete = { ...nativeOnly, "steps.jsc-producer.outputs.jsc-ready": "" };
  expect(conditions.map(condition => cacheCondition(condition, incomplete, true))).toEqual([false, false]);
  const exact = { ...outputs, "steps.jsc-prebuild-cache.outputs.cache-hit": "true", "steps.jsc-cargo-cache.outputs.cache-hit": "true" };
  expect(conditions.map(condition => cacheCondition(condition, exact, true))).toEqual([false, false]);
}

function cachePatterns(template: string): string[] {
  return Array.from(template.matchAll(/hashFiles\(([^)]+)\)/g)).flatMap(match =>
    Array.from((match[1] ?? "").matchAll(/'([^']+)'/g), part => part[1] ?? ""));
}

function nativeCacheInputs(template: string): Map<string, Buffer> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const paths = new Set(cachePatterns(template).filter(pattern => !pattern.startsWith("!")).flatMap(pattern =>
    Array.from(new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true, dot: true }))));
  return new Map(Array.from(paths, path => [path, readFileSync(join(root, path))]));
}

function expandNativeKey(template: string, inputs: ReadonlyMap<string, Buffer>): string {
  return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_whole: string, expression: string) => {
    if (expression === "runner.os") return "Linux";
    if (expression === "runner.arch") return "X64";
    if (expression === "steps.host-tools.outputs.hash") return "20261012.334.1";
    if (expression === "steps.native-inputs.outputs.hash") return "effective-native-inputs";
    if (expression === "steps.jsc-inputs.outputs.hash") return "effective-jsc-inputs";
    if (!expression.startsWith("hashFiles(")) throw new Error(`Unexpected cache expression: ${expression}`);
    const paths = matchingCachePaths(cachePatterns(`\${{ ${expression} }}`), inputs.keys());
    if (paths.length === 0) return "";
    const hash = createHash("sha256");
    for (const path of paths) {
      const bytes = inputs.get(path);
      if (!bytes) throw new Error(`Missing keyed input: ${path}`);
      hash.update(createHash("sha256").update(bytes).digest());
    }
    return hash.digest("hex");
  });
}

for (const { id, saveName, condition, workflowCompatible } of [
  { id: "native-cargo-cache", saveName: "Save the refined native Cargo cache once per input revision", condition: "steps.native-cargo-cache.outputs.cache-hit != 'true' && (github.event_name == 'push' || steps.native-cargo-cache.outputs.cache-matched-key == '')", workflowCompatible: true },
  { id: "native-cache", saveName: "Save the native quality checkpoint", condition: "${{ !cancelled() && steps.native-producers.outputs.native-ready == 'true' && steps.native-cargo-cache.outputs.cache-matched-key == '' && steps.native-cache.outputs.cache-hit != 'true' }}", workflowCompatible: true },
]) {
  test(`${id} distinguishes tools builders and producers with its own guarded save`, () => {
    const contract = nativeCacheContract(id, saveName);
    expect(contract.primary).toBe(contract.save);
    expect(contract.restorePath).toBe(contract.savePath);
    expect(contract.condition).toBe(condition);
    const inputs = nativeCacheInputs(contract.primary);
    const saved = expandNativeKey(contract.save, inputs);
    for (const path of ["scripts/build-bun-tools.sh", ".github/workflows/ci.yml"]) {
      assertProducerMutation(contract, inputs, saved, path, path.endsWith(".sh") || workflowCompatible);
    }
  });
}

function assertProducerMutation(contract: ReturnType<typeof nativeCacheContract>, inputs: ReadonlyMap<string, Buffer>, saved: string, path: string, compatible: boolean) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const before = path.endsWith(".sh") ? source.replace(/(?:cargo|"\$GUEST_CARGO") build --locked/, match => match.replace(" --locked", "")) :
    source.replace(/      - name: Build the single tools fixture[^]*?(?=      - name: Blocking Web guest cases)/, "");
  expect(before).not.toBe(source);
  const changed = new Map(inputs);
  changed.set(path, Buffer.from(before));
  const requested = expandNativeKey(contract.primary, changed);
  expect(requested).not.toBe(saved);
  expect(expandNativeKey(contract.save, changed)).toBe(requested);
  expect(saved.startsWith(expandNativeKey(contract.prefix, changed))).toBe(compatible);
}

test("native v4 fallback still excludes incompatible environment and toolchain inputs", () => {
  const { primary, prefix } = nativeCacheContract("native-cache", "Save the native quality checkpoint");
  const inputs = nativeCacheInputs(primary);
  const saved = expandNativeKey(primary, inputs);
  for (const path of ["env.sh", ".cargo/config.toml", "rust-toolchain.toml", "scripts/ci-binaryen.ts"]) {
    const changed = new Map(inputs);
    changed.set(path, Buffer.concat([readFileSync(new URL(`../${path}`, import.meta.url)), Buffer.from("\nchanged input\n")]));
    expect(saved.startsWith(expandNativeKey(prefix, changed))).toBe(false);
  }
});

const prebuildStepName = "Build or verify the JSC prebuild";

function prebuildScript(): string {
  return workflowString(workflowField(nativeWorkflowStep("name", prebuildStepName), "run"));
}

function replaceWorkload(script: string, functionName: string, body: string): string {
  const pattern = new RegExp(`^${functionName}\\(\\) \\{\\n[^]*?^\\}`, "m");
  if (!pattern.test(script)) throw new Error(`Missing owned workload: ${functionName}`);
  return script.replace(pattern, () => `${functionName}() {\n${body}\n}`);
}

test("ordered producers keep every blocking native command and save JSC before native work", () => {
  const script = prebuildScript();
  const step = nativeWorkflowStep("name", prebuildStepName);
  expect(workflowField(step, "shell")).toBe("bash");
  expect(step).not.toHaveProperty("if");
  expect(workflowField(step, "env")).toEqual({
    CI_JSC_PREBUILD_HIT: "${{ steps.jsc-prebuild-cache.outputs.cache-matched-key != '' }}",
  });
  const before = rust.slice(0, rust.indexOf(`name: ${prebuildStepName}`));
  for (const prerequisite of ["Build patched WASI sysroot", "Preserve unchanged build-script input timestamps", "Configure private JSC build paths", "id: jsc-prebuild-cache", "id: jsc-cargo-cache"]) {
    expect(before).toContain(prerequisite);
  }
  const native = nativeScript() + ["Build native fixtures after the cache checkpoint", "Blocking native fixture checks"]
    .map(name => workflowString(workflowField(nativeWorkflowStep("name", name), "run"))).join("");
  const commands = ["bun run quality --native", "bun scripts/quality-input-times.ts", "cargo test --locked", "cargo build --release --locked -j 2 -p bunwasm-host", "CARGO_BUILD_JOBS=2 bash scripts/build.sh", "bun scripts/test-checks.ts native", "bun tests/install/package-options.ts", "bun tests/install/root-overrides.ts"];
  const positions = commands.map(command => native.indexOf(command));
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  for (const command of commands) expect(native.split(command)).toHaveLength(2);
  expect(native).toContain('export BUN_CORE_BUILD_DIR="$CARGO_TARGET_DIR/split-common"');
  expect(native).toContain("CARGO_BUILD_JOBS=2 bash scripts/build.sh");
  expect(native.match(/bash scripts\/build\.sh/g)).toHaveLength(1);
  expect(native).not.toContain("guest-build-receipt.ts inputs quickjs");
  expect(native).not.toContain("build-bun-core.sh");
  expect(script).toContain('export JOBS=2 CAGE=');
  expect(script).toContain("check_jsc_inputs_stamp");
  expect(script.match(/bash scripts\/build-jsc.sh/g)).toHaveLength(1);
  expect(script).not.toContain("cargo");
  expect(script.indexOf("trap cleanup EXIT")).toBeLessThan(script.indexOf("set -m"));
  expect(script).toContain(') > "$jsc_log" 2>&1 &\njsc_pid=$!');
  expect(script).toContain("set +m\n  trap - EXIT INT TERM\n  run_jsc_prebuild");
  expect(script).toContain('wait "$jsc_pid"\n[[ "$(cat "$jsc_completion")" == verified ]]\necho "jsc-ready=true" >> "$GITHUB_OUTPUT"');
  expect(script).not.toContain("tee");
  const save = rust.indexOf("name: Save the JSC prebuild cache");
  expect(save).toBeGreaterThan(rust.indexOf(`name: ${prebuildStepName}`));
  expect(save).toBeLessThan(rust.indexOf("name: Blocking native quality checks"));
});

function nativeScript(): string {
  return workflowString(workflowField(nativeWorkflowStep("name", "Blocking native quality checks"), "run"));
}

type PrebuildControl = { jscStatus?: number; signal?: "SIGINT" | "SIGTERM" };

async function waitForControlFile(path: string): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await Bun.file(path).exists() ? readFileSync(path, "utf8") : "";
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Synthetic prebuild did not reach ${path}`);
}

function controlledPrebuild(): string {
  const jsc = `
  printf '%s' "$BASHPID" > "$RUNNER_TEMP/jsc-pid"
  printf 'prebuild stderr retained\\n' >&2
  bash -c 'printf "%s" "$$" > "$RUNNER_TEMP/descendant-pid"; exec sleep 30' &
  descendant=$!
  while [[ ! -f "$RUNNER_TEMP/jsc-release" ]]; do sleep 0.01; done
  if [[ "$(cat "$RUNNER_TEMP/jsc-release")" == 0 ]]; then
    kill "$descendant"
    wait "$descendant" || true
  fi
  printf 'jsc-done\\n' >> "$RUNNER_TEMP/events"
  return "$(cat "$RUNNER_TEMP/jsc-release")"`;
  return replaceWorkload(prebuildScript(), "run_jsc_prebuild", jsc);
}

async function checkPrebuildControl(control: PrebuildControl) {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-owned-prebuild-"));
  const child = Bun.spawn(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", controlledPrebuild()], {
    env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "outputs"), CI_JSC_PREBUILD_HIT: "false" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const outsider = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  try {
    await waitForControlFile(join(directory, "descendant-pid"));
    await releasePrebuildControl(control, directory, child);
    const status = await waitForControlExit(child);
    expect(status).toBe(control.signal === "SIGINT" ? 130 : control.signal === "SIGTERM" ? 143 : control.jscStatus || 0);
    expect(outsider.exitCode).toBeNull();
    expect(await errors).not.toContain("unbound variable");
    await assertPrebuildOutcome(control, directory, await output);
  } finally {
    // The fallback kills only the group whose PID the synthetic workload recorded.
    const pidFile = join(directory, "jsc-pid");
    if (await Bun.file(pidFile).exists()) signalOwnedGroup(Number(readFileSync(pidFile, "utf8")));
    if (child.exitCode === null) child.kill("SIGKILL");
    outsider.kill();
    await Promise.all([child.exited, outsider.exited, output, errors]);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitForControlExit(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (child.exitCode === null) throw new Error("Owned prebuild did not exit");
  return child.exited;
}

function signalOwnedGroup(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid owned process group: ${pid}`);
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
}

async function releasePrebuildControl(control: PrebuildControl, directory: string, child: ReturnType<typeof Bun.spawn>) {
  if (control.signal) { child.kill(control.signal); return; }
  writeFileSync(join(directory, "jsc-release"), String(control.jscStatus ?? 0));
}

async function assertPrebuildOutcome(control: PrebuildControl, directory: string, output: string) {
  expect(await Bun.file(join(directory, "outputs")).exists()).toBe(!control.signal && !control.jscStatus);
  expect(output).toContain("prebuild stderr retained");
  expect(readFileSync(join(directory, "jsc-prebuild.log"), "utf8")).toContain("prebuild stderr retained");
  for (const file of ["jsc-pid", "descendant-pid"]) {
    const pid = Number(readFileSync(join(directory, file), "utf8"));
    await waitForProcessExit(pid);
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    return false;
  }
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Owned process ${pid} survived cleanup`);
}

for (const [label, control] of [
  ["prebuild completes", {}], ["prebuild fails", { jscStatus: 42 }],
  ["cancel with SIGINT", { signal: "SIGINT" }], ["cancel with SIGTERM", { signal: "SIGTERM" }],
] satisfies [string, PrebuildControl][]) {
  test(`extracted ordered prebuild lifecycle: ${label}`, () => checkPrebuildControl(control), 10000);
}

test("the owned scheduling fragment changes exact native keys without widening fallback compatibility", () => {
  const changedWorkflow = workflow.replace("          run_native_checks\n", "          run_native_checks # changed producer\n");
  expect(changedWorkflow).not.toBe(workflow);
  for (const { id, saveName, compatible } of [
    { id: "native-cargo-cache", saveName: "Save the refined native Cargo cache once per input revision", compatible: true },
    { id: "native-cache", saveName: "Save the native quality checkpoint", compatible: true },
  ]) {
    const contract = nativeCacheContract(id, saveName);
    const inputs = nativeCacheInputs(contract.primary);
    const saved = expandNativeKey(contract.primary, inputs);
    inputs.set(".github/workflows/ci.yml", Buffer.from(changedWorkflow));
    expect(expandNativeKey(contract.primary, inputs)).not.toBe(saved);
    expect(expandNativeKey(contract.save, inputs)).toBe(expandNativeKey(contract.primary, inputs));
    expect(saved.startsWith(expandNativeKey(contract.prefix, inputs))).toBe(compatible);
  }
});

for (const hit of [false, true]) {
  test(`extracted JSC branch propagates ${hit ? "stamp validation" : "builder"} failure before advertising completion`, () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-prebuild-branch-"));
    try {
      mkdirSync(join(directory, "jsc"));
      mkdirSync(join(directory, "scripts"));
      writeFileSync(join(directory, "env.sh"), "export JSC_CHILD_ONLY=private\n");
      writeFileSync(join(directory, "jsc/common.sh"), 'check_jsc_inputs_stamp() { echo stamp-rejected >&2; return 43; }\n');
      writeFileSync(join(directory, "scripts/build-jsc.sh"), 'echo build-rejected >&2\nexit 44\n');
      const script = prebuildScript();
      const env = { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "outputs"), CI_JSC_PREBUILD_HIT: String(hit) };
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: directory, env, encoding: "utf8", timeout: 3000 });
      expect(result.status).toBe(hit ? 43 : 44);
      expect(Bun.spawnSync(["test", "!", "-e", join(directory, "outputs")]).exitCode).toBe(0);
      expect(result.stdout).toContain(hit ? "stamp-rejected" : "build-rejected");
      expect(result.stdout).not.toContain(hit ? "build-rejected" : "stamp-rejected");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("extracted foreground commands fail on an intermediate pipeline, not just the last command", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-native-failure-"));
  try {
    const script = replaceWorkload(nativeScript(), "run_native_checks", '  false | true\n  echo masked-failure');
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "outputs") }, encoding: "utf8", timeout: 3000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("masked-failure");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cancellation between fork and PID capture still reaps the sole owned group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-prebuild-fork-signal-"));
  try {
    const script = controlledPrebuild().replace('jsc_pid=$!', () => 'while [[ ! -s "$RUNNER_TEMP/descendant-pid" ]]; do sleep 0.01; done\n  kill -TERM "$$"\n  jsc_pid=$!');
    expect(script).not.toBe(controlledPrebuild());
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "outputs") }, encoding: "utf8", timeout: 3000,
    });
    expect(result.status).toBe(143);
    await assertPrebuildOutcome({ signal: "SIGTERM" }, directory, result.stdout);
  } finally {
    const pidFile = join(directory, "jsc-pid");
    if (await Bun.file(pidFile).exists()) signalOwnedGroup(Number(readFileSync(pidFile, "utf8")));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed diagnostic display cannot replace the real prebuild exit status", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-prebuild-status-"));
  try {
    const script = replaceWorkload(prebuildScript(), "run_jsc_prebuild", "  return 42")
      .replace('cat "$jsc_log"', "false");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, "outputs") }, encoding: "utf8", timeout: 3000,
    });
    expect(result.status).toBe(42);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the JSC guest builds once in the background, overlapping only other builds", () => {
  const start = rust.indexOf("name: Start the JSC Cargo guest build");
  const wait = rust.indexOf("name: Build the JSC Cargo guest\n");
  expect(start).toBeGreaterThan(rust.indexOf("name: Save the native quality checkpoint"));
  expect(start).toBeGreaterThan(rust.indexOf("name: Install the Web host dependencies"));
  expect(start).toBeLessThan(rust.indexOf("name: Build native fixtures after the cache checkpoint"));
  expect(wait).toBeGreaterThan(rust.indexOf("name: Build one host-engine guest"));
  expect(wait).toBeLessThan(rust.indexOf("name: Blocking native fixture checks"));
  expect(wait).toBeLessThan(rust.indexOf("name: Build the single tools fixture"));
  expect(rust.match(/bash scripts\/build-bun-jsc\.sh/g)).toHaveLength(1);
  const launch = workflowString(workflowField(nativeWorkflowStep("name", "Start the JSC Cargo guest build"), "run"));
  expect(launch).toContain("setsid nice -n 19 bash -c");
  expect(launch).toContain("< /dev/null &");
});

for (const [label, status, expected] of [
  ["a finished build passes", "0", 0], ["a failed build fails", "3", 1],
  ["a build that died without a status fails", undefined, 1],
] satisfies [string, string | undefined, number][]) {
  test(`JSC guest wait: ${label}`, () => {
    const script = workflowString(workflowField(nativeWorkflowStep("name", "Build the JSC Cargo guest"), "run"));
    const directory = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-guest-wait-"));
    try {
      const state = join(directory, "jsc-guest");
      mkdirSync(state);
      writeFileSync(join(state, "build.log"), "background build log\n");
      // Above Linux's largest pid_max, so the recorded build process is gone.
      writeFileSync(join(state, "pid"), String(2 ** 22 + 1));
      if (status !== undefined) writeFileSync(join(state, "status"), `${status}\n`);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { env: { ...process.env, RUNNER_TEMP: directory }, encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(expected);
      expect(result.stdout).toContain("background build log");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
