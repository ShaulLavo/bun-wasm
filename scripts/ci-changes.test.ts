import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, needsJsc, needsRust } from "./ci-changes";

test.each([
  "checks/native-console.json", "checks/runtime-leaf.json", "scripts/test-checks.ts", "tests/fixtures/console-format/index.js",
  "jsc/wasi-jsc.cmake", "tests/fixtures/runtime-proc-spawn-requests.json", "tests/fixtures/source-cache/index.ts",
  "web/tests/bun-runtime-proc-fixtures.ts", "web/tests/bun-runtime-proc-browser.ts", "web/tests/bun-runtime-proc-main.ts",
  "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh",
  "crates/bunwasm-runtime/src/lib.rs", "vendor/bun/src/parser.rs", "patches/bun/001.patch",
  "third_party/libc/src/lib.rs", "Cargo.lock", "Cargo.toml", ".cargo/config.toml", "rust-toolchain.toml",
  "tests/install/package-options.ts", "tests/install/registry.mjs", "tests/wasm-tables/table.wasm", "tests/fixtures/webassembly/module.wasm",
  "env.sh", "tests/fixtures/node-misc/main.js", "scripts/test.sh", "scripts/build-wasi-sysroot.ts", "scripts/sync-crypto.sh", "scripts/quality-rust.ts", "scripts/rust-test-packages.ts",
  "scripts/quality-wasi-probe.ts", "scripts/quality.ts", "scripts/ci-changes.ts", "package.json", "bun.lock",
  ".github/workflows/ci.yml", "scripts/build.sh", "scripts/browser-build.ts", "scripts/guest-build-receipt.ts", "scripts/transpile-runtime.ts",
  "scripts/check-quickjs-async-context.ts", "scripts/fixtures/quickjs-async-context.c", "scripts/fixtures/quickjs-async-context.ts",
])("native input %s retains every Rust gate", path => {
  expect(needsRust([path])).toBe(true);
});

test.each(["scripts/waffle-release-inputs.ts", "scripts/waffle-release-inputs.json"])("Waffle native release input %s selects both engine gates", path => {
  expect(needsRust([path])).toBe(true);
  expect(needsJsc([path])).toBe(true);
});

test.each(["src/index.ts", "web/src/worker.ts", "sandbox/src/main.ts", "site/src/main.ts", "docs/code-quality.md", "scripts/ci-quality.test.ts", "checks/web-leaf.json", "checks/quality-leaf.json"])("JavaScript/documentation input %s needs no Rust compilation", path => {
  expect(needsRust([path])).toBe(false);
});

test.each(["crates/bunwasm-runtime/src/js/runtime.d.ts", "crates/bunwasm-runtime/src/js/worker_protocol.d.ts"])("type-only runtime declaration %s needs no native engine build", path => {
  expect(needsRust([path])).toBe(false);
  expect(needsJsc([path])).toBe(false);
});

test("embedded runtime JavaScript remains a native and JSC input", () => {
  const path = "crates/bunwasm-runtime/src/js/node_fs.js";
  expect(needsRust([path])).toBe(true);
  expect(needsJsc([path])).toBe(true);
});

test("the complete change list includes native inputs after any number of JavaScript paths", () => {
  const paths = Array.from({ length: 500 }, (_, index) => `web/src/file${index}.ts`);
  expect(needsRust(paths.concat(["crates/bunwasm-cli/src/main.rs"]))).toBe(true);
  expect(needsRust([])).toBe(false);
});

test("new push branches run Rust and malformed comparisons fail closed", () => {
  expect(needsRust(changedPaths("0".repeat(40), "a".repeat(40), false))).toBe(true);
  expect(() => changedPaths("", "a".repeat(40), true)).toThrow("full base and head");
});


let fixture: string | undefined;
let base = "";
let native = "";
let javascript = "";

function git(args: readonly string[]): string {
  if (!fixture) throw new Error("Fixture not initialized");
  return execFileSync("git", ["-C", fixture, "-c", "user.name=CI test", "-c", "user.email=ci@localhost"].concat(args), { encoding: "utf8" }).trim();
}

afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "bun-wasm-ci-changes-"));
  git(["init", "-q"]);
  mkdirSync(join(fixture, "crates"));
  writeFileSync(join(fixture, "crates/lib.rs"), "owned native input\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  base = git(["rev-parse", "HEAD"]);
  renameSync(join(fixture, "crates/lib.rs"), join(fixture, "moved.ts"));
  git(["add", "-A"]);
  git(["commit", "-qm", "move native input out of crates"]);
  native = git(["rev-parse", "HEAD"]);
  writeFileSync(join(fixture, "moved.ts"), "only JavaScript changed\n");
  git(["add", "."]);
  git(["commit", "-qm", "JavaScript only"]);
  javascript = git(["rev-parse", "HEAD"]);
});

function select(start: string, end: string, event = "pull_request"): string {
  return execFileSync("bun", [join(import.meta.dir, "ci-changes.ts"), start, end], {
    cwd: fixture, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("real PR diff catches a native file renamed into JavaScript", () => {
  expect(select(base, native)).toBe("rust=true\njsc=false");
  expect(select(native, javascript)).toBe("rust=false\njsc=false");
});

test("multi-commit main push includes earlier native changes", () => {
  expect(select(base, javascript, "push")).toBe("rust=true\njsc=false");
});

test("unavailable commit comparison fails rather than skipping native checks", () => {
  expect(() => select("f".repeat(40), javascript)).toThrow();
});

function commitInput(path: string): string {
  if (!fixture) throw new Error("Fixture not initialized");
  git(["checkout", "-q", "--detach", base]);
  mkdirSync(join(fixture, path, ".."), { recursive: true });
  writeFileSync(join(fixture, path), "changed input\n");
  git(["add", "."]);
  git(["commit", "-qm", `change ${path}`]);
  return git(["rev-parse", "HEAD"]);
}

for (const path of ["jsc/wasi-jsc.cmake", "tests/fixtures/runtime-proc-spawn-requests.json", "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh"]) {
  test.each(["pull_request", "push"])(`${path} retains native checks through the real %s event CLI`, event => {
    expect(select(base, commitInput(path), event)).toBe(`rust=true\njsc=${needsJsc([path])}`);
  });
}

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const quality = workflow.split("\n  quality:\n")[1]!.split("\n  rust:\n")[0]!;
for (const path of [
  "scripts/cmake-cache.test.ts", "scripts/run-with-timeout.mts", "jsc/configure.sh", "jsc/build.sh", "jsc/common.sh",
  "scripts/real-runtime-network-tls.sh", "jsc/shim/wasi-compat.h", "jsc/shim/wasi-compat.c", "jsc/shim/madvise.c",
]) {
  test.each(["pull_request", "push"])(`${path} keeps the blocking lightweight CMake owner for a real %s event`, event => {
    expect(select(base, commitInput(path), event)).toBe(`rust=${needsRust([path])}\njsc=${needsJsc([path])}`);
    expect(quality).toContain("run: bun scripts/test-checks.ts cmake");
    expect(quality).not.toMatch(/^ {4}(?:if|needs):/m);
  });
}


test("patch-only manifest bumps skip Rust but dependency and script edits retain it", () => {
  if (!fixture) throw new Error("Fixture not initialized");
  const first = commitInput("package.json");
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "0.0.1", scripts: { quality: "bun quality.ts" } }));
  git(["commit", "-qam", "manifest inputs"]);
  const manifestBase = git(["rev-parse", "HEAD"]);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "0.0.2", scripts: { quality: "bun quality.ts" } }));
  git(["commit", "-qam", "patch bump"]);
  const bumped = git(["rev-parse", "HEAD"]);
  expect(select(manifestBase, bumped)).toBe("rust=false\njsc=false");
  expect(select(manifestBase, bumped, "push")).toBe("rust=false\njsc=false");
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "0.0.3", scripts: { quality: "bun changed-quality.ts" } }));
  git(["commit", "-qam", "change native driver"]);
  expect(select(bumped, git(["rev-parse", "HEAD"]))).toBe("rust=true\njsc=false");
  expect(() => select(first, bumped)).toThrow();
});

for (const path of [
  "jsc/webkit-wasi.patch", "crates/bunwasm-jsc/cpp/helpers.cpp", "scripts/jsc-embedding.ts",
  "crates/bunwasm-engine-quickjs/src/program.rs", "crates/bunwasm-engine-quickjs/src/loader.rs", "crates/bunwasm-engine-quickjs/src/value_natives.rs",
  "crates/bunwasm-engine-quickjs/src/driver.rs", "crates/bunwasm-engine-quickjs/src/client.rs", "crates/bunwasm-engine-quickjs/src/natives.rs", "crates/bunwasm-engine-quickjs/src/allocator.rs", "crates/bunwasm-engine-quickjs/src/transport.rs", "crates/bunwasm-engine-quickjs/src/side_modules.rs",
  "crates/bunwasm-engine-jsc/src/lib.rs", "scripts/build-bun-jsc.sh", "scripts/build-engine-jsc.sh", "scripts/build-engine-quickjs.sh", "scripts/build-bun-core.sh", "scripts/build.sh", "scripts/quickjs-core-exports.txt",
  "scripts/guest-artifact.ts", "scripts/guest-build-receipt.ts", "scripts/guest-core-receipt.ts", "scripts/guest-engine-receipt.ts", "scripts/guest-source-manifest.ts", "scripts/guest-acceptance.ts",
  "scripts/src/engine-explicit-init.ts", "scripts/src/engine-init.c", "scripts/engine-producer.test.ts", "scripts/src/engine-explicit-init.test.ts",
  "src/engine-kind.ts", "src/assets.ts", "src/quickjs-program.ts", "web/src/engine-loader.ts",
  "scripts/bench-jsc.sh", "scripts/ci-binaryen.ts", "tests/fixtures/shared-array-buffer/index.ts", "tests/jsc-embedding/growable-memory/index.ts",
  "web/scripts/node-host.ts", "web/scripts/node-worker.ts", "web/guest-tests/compose.ts", "web/src/net/trampoline.ts", "web/bun.lock",
  "web/src/native-direct-stream.ts",
  "crates/bunwasm-runtime/src/host.rs", "scripts/test-web-guests.ts",
  "scripts/sync-bun.sh", "scripts/sync-crypto.sh", "tests/fixtures/runtime-proc-spawn-requests.json",
]) {
  test.each(["pull_request", "push"])(`${path} selects actual JSC embedding execution for %s`, event => {
    expect(needsJsc([path])).toBe(true);
    expect(select(base, commitInput(path), event)).toBe("rust=true\njsc=true");
  });
}

test("unrelated page changes skip JSC; its selected gate builds and executes once", () => {
  expect(needsJsc(["web/src/page.ts", "docs/jsc-build.md"])).toBe(false);
  expect(workflow).toContain("if: needs.quality.outputs.jsc == 'true'");
  expect(workflow.match(/bash scripts\/build-jsc.sh/g)).toHaveLength(1);
  expect(workflow.match(/bash scripts\/build-bun-jsc.sh/g)).toHaveLength(1);
  expect(workflow).toContain("bun scripts/jsc-embedding.ts test dist/bun-jsc.wasm");
});

test("the paired JSC contract selects its crate, producer and consumer inputs", () => {
  const paths = [
    "crates/bunwasm-engine-jsc/src/lib.rs",
    "scripts/build-engine-jsc.sh",
    "scripts/guest-build-receipt.ts",
    "src/engine-kind.ts",
    "web/src/engine-loader.ts",
  ];
  expect(needsJsc(paths)).toBe(true);
  expect(needsRust(paths)).toBe(true);
  expect(needsJsc(["web/src/page.ts", "src/index.ts", "sandbox/src/main.ts"])).toBe(false);
});

for (const path of ["web/src/main.ts", "sandbox/src/main.ts", "site/src/main.ts", "docs/ci-web-guests.md"]) {
  test.each(["pull_request", "push"])(`${path} keeps engine builds off through the real %s event CLI`, event => {
    expect(select(base, commitInput(path), event)).toBe("rust=false\njsc=false");
  });
}

for (const path of ["web/guest-tests/quickjs.test.ts", "web/guest-tests/browser.test.ts", "web/guest-tests/jsc.test.ts"]) {
  test.each(["pull_request", "push"])(`${path} selects only its own engine owner through the real %s event CLI`, event => {
    expect(select(base, commitInput(path), event)).toBe(`rust=true\njsc=${path.endsWith("jsc.test.ts")}`);
  });
}

test("the busy-loop stdout fixture and its handshake runner select the native and JSC gates", () => {
  for (const path of ["tests/fixtures/stdout-busy-loop/index.ts", "tests/test-stdout-busy-loop.ts"]) {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(true);
  }
});

test("the Astro response fixture selects the existing native and JSC gates", () => {
  const paths = ["tests/fixtures/astro-http2-response/index.ts"];
  expect(needsRust(paths)).toBe(true);
  expect(needsJsc(paths)).toBe(true);
});

for (const path of ["crates/bunwasm-host/src/linked.rs", "crates/bunwasm-engine-quickjs/src/vm.rs", "crates/bunwasm-engine-quickjs/src/lib.rs"]) {
  test.each(["pull_request", "push"])(`${path} retains native-only selection for %s`, event => {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(false);
    expect(select(base, commitInput(path), event)).toBe("rust=true\njsc=false");
  });
}
