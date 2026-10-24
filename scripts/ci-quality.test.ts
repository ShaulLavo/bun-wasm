import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  expect(checkCommand("native")).toEqual(["bash", join(import.meta.dir, "test.sh"), "--no-build"].concat(oldSelections().native.toSorted().map(path => path.slice("tests/fixtures/".length))));
  expect(rust).toContain('BUN_WASM_LAUNCHER="$CARGO_TARGET_DIR/release/bun-wasm" bun tests/install/package-options.ts');
  expect(rust.match(/cargo build[^\n]*--target wasm32-wasip1[^\n]*-p bunwasm-cli/g)).toHaveLength(1);
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
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-matched-key == '' && steps.native-cache.outputs.cache-hit != 'true'");
  expect(rust).toContain("JSC_CARGO_TARGET_DIR=$RUNNER_TEMP/jsc/target");
  expect(rust).toContain("key: jsc-prebuild-v1-");
  expect(rust).toContain("key: jsc-cargo-v1-");
  expect(rust).toContain("'scripts/ci-binaryen.ts'");
  expect(rust).toContain("'crates/**'");
});

type CacheFiles = Readonly<Record<string, string>>;

function nativeKeyTemplates(namespace: string) {
  const lines = rust.split("\n").filter(line => line.trim().startsWith(`${namespace}-`) || line.trim().startsWith(`key: ${namespace}-`));
  const [primary, prefix, save] = lines.map(line => line.trim().replace(/^key: /, ""));
  if (!primary || !prefix || !save || lines.length !== 3) throw new Error(`Missing cache keys for ${namespace}`);
  return { primary, prefix, save };
}

function fixtureHash(expression: string, files: CacheFiles): string {
  const patterns = Array.from(expression.matchAll(/'([^']+)'/g), match => new Bun.Glob(match[1]!));
  const paths = Object.keys(files).sort().filter(path => patterns.some(pattern => pattern.match(path)));
  if (paths.length === 0) return "";
  const digest = createHash("sha256");
  for (const path of paths) digest.update(createHash("sha256").update(files[path]!).digest());
  return digest.digest("hex");
}

function fixtureCacheKey(template: string, files: CacheFiles, image = "20261012.334.1"): string {
  return template.replace(/\$\{\{ (.*?) \}\}/g, (_, expression: string) => {
    if (expression === "runner.os") return "Linux";
    if (expression === "runner.arch") return "X64";
    if (expression === "steps.homes.outputs.image") return image;
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
  "crates/bunwasm-crypto-sys/c/rsa.c": "native C source",
  "crates/bunwasm-jsc/cpp/helpers.cpp": "JSC Cargo C++ helper",
  ".cargo/config.toml": "SQLite compile flags",
  "rust-toolchain.toml": "nightly-2026-09-15",
  ".github/workflows/ci.yml": workflow,
  "env.sh": "SDK/sysroot environment",
  "bun.lock": "installed sysroot builder identity",
  "scripts/build-wasi-sysroot.ts": "sysroot builder",
  "scripts/sync-crypto.sh": "BoringSSL source pin",
  "patches/bun/0001.patch": "upstream patch",
  "third_party/zlib-ng/zlib.h.in": "native header",
  "jsc/wasi-jsc.cmake": "WASI C++ toolchain",
  "scripts/check-cmake-cache.cmake": "CMake preflight",
};

function changedCacheFile(path: string, contents = "changed"): CacheFiles {
  return { ...nativeCacheFiles, [path]: contents };
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
  for (const path of Object.keys(nativeCacheFiles).filter(path => !path.includes("Cargo.") && !path.endsWith("engine_jsc.rs"))) {
    const files = changedCacheFile(path);
    expect(fixtureCacheKey(keys.primary, files)).not.toBe(saved);
    expect(saved.startsWith(fixtureCacheKey(keys.prefix, files))).toBe(false);
  }
  const sdkChange = changedCacheFile(".github/workflows/ci.yml", workflow.replaceAll("wasi-sdk-34", "wasi-sdk-35"));
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, sdkChange))).toBe(false);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles, "next-image"))).toBe(false);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles).replace("Linux-X64", "Linux-ARM64"))).toBe(false);
  expect(saved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles).replace("Linux-X64", "macOS-X64"))).toBe(false);
});

test("old Cargo-first keys cannot use the new compatibility prefix, and fallback never overlays a match", () => {
  const old = nativeKeyTemplates("native-v4");
  const keys = nativeKeyTemplates(nativeCargoNamespace);
  const oldSaved = fixtureCacheKey(old.save, nativeCacheFiles);
  expect(oldSaved.startsWith(fixtureCacheKey(old.prefix, changedCacheFile("Cargo.lock")))).toBe(false);
  expect(oldSaved.startsWith(fixtureCacheKey(keys.prefix, nativeCacheFiles))).toBe(false);
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-matched-key == ''");
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-hit != 'true'");
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-matched-key == '' && steps.native-cache.outputs.cache-hit != 'true'");
});

test("JSC prebuild and Cargo caches keep separate authoritative identities", () => {
  const prebuildKeys = rust.split("\n").filter(line => line.includes("key: jsc-prebuild-v1-"));
  const cargoKeys = rust.split("\n").filter(line => line.includes("key: jsc-cargo-v1-"));
  expect(prebuildKeys).toHaveLength(2);
  expect(cargoKeys).toHaveLength(2);
  expect(rust).toContain("path: ${{ runner.temp }}/jsc/prebuild");
  expect(rust).toContain("path: ${{ runner.temp }}/jsc/target");
  expect(rust).not.toContain("path: ${{ runner.temp }}/jsc\n");

  const groups = (key: string) => Array.from(key.matchAll(/hashFiles\(([^)]+)\)/g), match =>
    Array.from(match[1]!.matchAll(/'([^']+)'/g), item => item[1]!));
  const matches = (pattern: string, path: string) => {
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
    if (!pattern.includes("*")) return pattern === path;
    const [prefix, suffix] = pattern.split("*");
    return path.startsWith(prefix!) && path.endsWith(suffix!);
  };
  const changedGroups = (key: string, path: string) => groups(key)
    .map((patterns, index) => patterns.some(pattern => matches(pattern, path)) ? index : -1)
    .filter(index => index >= 0);
  const prebuild = prebuildKeys[0]!;
  const cargo = cargoKeys[0]!;

  expect(changedGroups(prebuild, "crates/bunwasm-runtime/src/engine_jsc.rs")).toEqual([]);
  expect(changedGroups(cargo, "crates/bunwasm-runtime/src/engine_jsc.rs")).toEqual([1]);
  for (const input of ["jsc/wasi-jsc.cmake", "scripts/build-wasi-sysroot.ts", "env.sh", "scripts/ci-binaryen.ts"]) {
    expect(changedGroups(prebuild, input)).toEqual([0]);
  }
  expect(changedGroups(cargo, "jsc/wasi-jsc.cmake")).toEqual([0, 1]);
  expect(changedGroups(cargo, "rust-toolchain.toml")).toEqual([1]);

  const build = rust.split("name: Build or validate the single JSC prebuild")[1]!;
  expect(build).toContain("steps.jsc-prebuild-cache.outputs.cache-hit");
  expect(build).toContain("bash scripts/build-jsc.sh");
  expect(rust).not.toContain("steps.jsc-cache");
  const hostBuild = rust.indexOf("name: Build one host-engine guest for real-browser source cache acceptance");
  const jscGate = rust.indexOf("name: Blocking JSC embedding and allocation checks");
  for (const save of [
    rust.indexOf("name: Save the JSC prebuild cache once per input revision"),
    rust.indexOf("name: Save the JSC Cargo cache once per input revision"),
  ]) {
    expect(save).toBeGreaterThan(jscGate);
    expect(save).toBeGreaterThan(hostBuild);
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

test("native cache stays bounded per input revision, and the SDK is not copied per lock", () => {
  expect(rust).toContain("uses: actions/cache/restore@v4\n        id: native-cache");
  expect(rust).toContain("uses: actions/cache/restore@v4\n        id: native-cargo-cache");
  expect(rust.match(/uses: actions\/cache\/save@v4/g)).toHaveLength(4);
  expect(rust).toContain("if: steps.native-cargo-cache.outputs.cache-hit != 'true'");
  expect(rust).not.toContain("github.run_id");
  expect(rust).not.toContain("github.run_attempt");
  const sdkKey = rust.split("\n").find(line => line.includes("key: wasi-sdk-"))!;
  expect(sdkKey).not.toContain("hashFiles");
  expect(sdkKey).not.toContain("steps.homes.outputs.image");
  expect(rust).toContain("path: ${{ env.WASM_TOOLS }}/bun-wasm-sysroot-patched");
});

test("native target cache is saved after all selected JSC builds and checks", () => {
  const saves = [
    rust.indexOf("      - name: Save the refined native Cargo cache once per input revision"),
    rust.indexOf("      - name: Save the complete native fallback once per input revision"),
  ];
  expect(saves.every(index => index > -1)).toBe(true);
  expect(rust).toContain("JSC_CARGO_TARGET_DIR=$RUNNER_TEMP/jsc/target");
  for (const command of ["bash scripts/build-jsc.sh", "bash scripts/build-bun-jsc.sh", "bun scripts/jsc-embedding.ts test dist/bun-jsc.wasm"]) {
    const step = rust.indexOf(command);
    expect(step).toBeGreaterThan(-1);
    for (const save of saves) expect(save).toBeGreaterThan(step);
  }
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
  expect(setup).toContain("needs.quality.outputs.jsc == 'true'");
  expect(setup).not.toContain("cache-hit");
  expect(rust.indexOf(setup)).toBeLessThan(rust.indexOf("name: Build or validate the single JSC prebuild"));
});

test("Binaryen pin and installer identity participate in tool, fallback and JSC caches", () => {
  const keys = rust.split("\n").filter(line => /key: (?:binaryen-133|native-v4|jsc-(?:prebuild|cargo)-v1)|^\s+native-v4/.test(line));
  expect(keys).toHaveLength(8);
  expect(rust).toContain("path: ${{ env.WASM_TOOLS }}/binaryen-version_133-x86_64-linux.tar.gz");
  for (const key of keys) {
    expect(key).toContain("'scripts/ci-binaryen.ts'");
  }
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
