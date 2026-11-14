import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, needsJsc, needsRust, needsSharedNative, needsSharedSysroot } from "./ci-changes";
import { ordinaryFixtures } from "./spidermonkey-ordinary-fixtures.ts";

test("ordinary SpiderMonkey recipes, nested runtime inputs and each reviewed fixture select Rust", () => {
  const paths = ["spidermonkey/mozconfig.in", "spidermonkey/prepare-engine-inputs.ts", "spidermonkey/unresolved-symbols.json",
    "scripts/spidermonkey-ordinary-ci.ts", "scripts/spidermonkey-ordinary-ci.test.ts", "scripts/spidermonkey-ordinary-fixtures.ts",
    "scripts/spidermonkey-side-core-receipt.ts", "scripts/spidermonkey-side-inputs.ts", "checks/runtime-spidermonkey-ordinary-fixtures.json",
    "crates/bunwasm-runtime/src/data/codec.rs", "crates/bunwasm-runtime/src/ops/client.rs", "crates/bunwasm-engine-quickjs/src/side_modules.rs"]
    .concat(ordinaryFixtures.map(name => `tests/fixtures/${name}/expected.txt`));
  for (const path of paths) expect(needsRust([path])).toBe(true);
  expect(needsRust(["docs/bun-patches/spidermonkey-side-core-qualification.md", "spidermonkey/README.md"])).toBe(false);
});

test.each(["spidermonkey/README.md", "docs/bun-patches/spidermonkey-side-core-qualification.md"])("SpiderMonkey documentation %s selects no native producer", path => {
  expect(needsRust([path])).toBe(false);
  expect(needsSharedNative([path], ["tests/fixtures/shared-wasm-memory"])).toBe(false);
});

test.each(["spidermonkey/mozconfig.in", "spidermonkey/spidermonkey-wasi.patch", "spidermonkey/unresolved-symbols.json", "spidermonkey/irregexp-icu/allocator.cpp"])("SpiderMonkey native input %s retains ordinary and shared gates", path => {
  expect(needsRust([path])).toBe(true);
  expect(needsSharedNative([path], ["tests/fixtures/shared-wasm-memory"])).toBe(true);
});

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
  ".github/workflows/ci.yml", "scripts/build.sh", "scripts/guest-build-receipt.ts", "scripts/transpile-runtime.ts",
  "scripts/check-quickjs-async-context.ts", "scripts/fixtures/quickjs-async-context.c", "scripts/fixtures/quickjs-async-context.ts",
  "scripts/check-quickjs-memory-telemetry.ts", "scripts/fixtures/quickjs-memory-telemetry.c",
  "scripts/check-quickjs-parser-stack.ts", "scripts/fixtures/quickjs-parser-stack.c", "scripts/fixtures/quickjs-parser-stack.ts",
  "scripts/fixtures/quickjs-parser-stack.expected.txt",
  "scripts/check-quickjs-frame-stack.ts", "scripts/fixtures/quickjs-frame-stack.c", "scripts/fixtures/quickjs-frame-stack.ts",
  "scripts/fixtures/quickjs-frame-stack.expected.txt", "scripts/quickjs-native-check.ts",
  "scripts/check-quickjs-frame-wasi.ts", "scripts/fixtures/quickjs-frame-wasi.c",
])("native input %s retains every Rust gate", path => {
  expect(needsRust([path])).toBe(true);
});

test("the Rust compiler cache dispatcher selects every affected producer", () => {
  const paths = ["scripts/rustc-cache.sh"];
  expect(needsRust(paths)).toBe(true);
  expect(needsJsc(paths)).toBe(true);
  expect(needsSharedNative(paths)).toBe(true);
});

test.each(["web/src/bun-executor.ts", "web/src/engine-stack-budget.ts", "web/tests/browser-quickjs-stack.ts", "scripts/quickjs-stack-browser.test.ts", "checks/browser-guest-quickjs-stack.json", "tests/stack-depth.js"])("QuickJS browser stack input %s selects its guest producer", path => {
  expect(needsRust([path])).toBe(true);
});

test.each([
  "web/src/engine-stack-budget.ts", "web/src/bun-executor.ts", "tests/stack-depth.js", "scripts/stack-measurement.ts", "scripts/jsc-parser-reserve.ts",
  "web/tests/browser-jsc-parser-reserve.ts", "web/tests/parser-reserve-ownership.ts", "scripts/jsc-parser-reserve-browser.test.ts",
  "checks/browser-guest-jsc-parser-reserve.json", "checks/native-parser-chain-stack.json", "tests/fixtures/parser-chain-stack/index.ts",
  "jsc/webkit-wasi.patch", "crates/bunwasm-jsc/cpp/helpers.cpp",
])("JSC parser reserve input %s selects the JSC producer its browser check requires", path => {
  expect(needsJsc([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});

test.each([
  "web/tests/parser-reserve-ownership.ts", "web/src/engine-stack-budget.ts", "tests/stack-depth.js", "scripts/stack-measurement.ts",
  "tests/fixtures/shared-wasm-memory/parser-reserve-ownership.ts", "jsc/webkit-wasi.patch",
])("parser reserve ownership input %s selects the shared-group producer", path => {
  expect(needsSharedNative([path])).toBe(true);
});

const browserBuildFiles = ["scripts/browser-build.ts", "web/build.ts"];

test.each([{ paths: browserBuildFiles.slice(0, 1) }, { paths: browserBuildFiles.slice(1) }, { paths: browserBuildFiles }])("shared consumers and profile-aware page bundling select their launcher: $paths", ({ paths }) => {
  expect(needsRust(paths)).toBe(true);
  expect(needsSharedNative(paths)).toBe(true);
  expect(needsJsc(paths)).toBe(false);
  expect(needsSharedSysroot(paths)).toBe(false);
});

test.each(["web/index.html", "web/src/playground/app.tsx"])("presentation-only page input %s does not select native producers", path => {
  expect(needsRust([path])).toBe(false);
  expect(needsSharedNative([path])).toBe(false);
  expect(needsJsc([path])).toBe(false);
  expect(needsSharedSysroot([path])).toBe(false);
});

test.each(browserBuildFiles)("browser bundling with native inputs retains their gates: %s", path => {
  expect(needsRust([path, "crates/bunwasm-cli/src/main.rs"])).toBe(true);
  expect(needsJsc([path, "jsc/wasi-jsc.cmake"])).toBe(true);
  expect(needsSharedSysroot([path, "scripts/build-shared-wasi-libc.sh"])).toBe(true);
});

test.each(browserBuildFiles)("browser build file %s remains a native input when declared by a probe", path => {
  expect(needsRust([path], [path])).toBe(true);
});

test.each([
  ".github/workflows/ci.yml", "scripts/build-wasi-sysroot.ts", "scripts/build-shared-wasi-libc.sh",
  "scripts/test-shared-sysroot.sh", "scripts/shared-sysroot-proof.ts", "scripts/shared-sysroot-native.ts",
  "tests/fixtures/shared-sysroot/member.c", "patches/wasi-libc/group-grow.patch",
])("shared sysroot input %s selects the path-filtered proof gate", path => {
  expect(needsSharedSysroot([path])).toBe(true);
});

test.each(["src/index.ts", "docs/code-quality.md", "scripts/ci-quality.test.ts"])("unrelated input %s skips the shared sysroot gate", path => {
  expect(needsSharedSysroot([path])).toBe(false);
});

test.each(["scripts/waffle-release-inputs.ts", "scripts/waffle-release-inputs.json"])("Waffle native release input %s selects both engine gates", path => {
  expect(needsRust([path])).toBe(true);
  expect(needsJsc([path])).toBe(true);
});

test("native handoff roots alone select producer and consumer engine gates", () => {
  const paths = ["scripts/ci-native-handoff-paths.ts"];
  expect(needsRust(paths)).toBe(true);
  expect(needsJsc(paths)).toBe(true);
});

test("JSC artifact inventory changes select ordinary and shared consumers", () => {
  const paths = ["scripts/ci-jsc-artifact.ts"];
  expect(needsRust(paths)).toBe(true);
  expect(needsJsc(paths)).toBe(true);
  expect(needsSharedNative(paths)).toBe(true);
});

test.each(["src/index.ts", "site/src/main.ts", "docs/code-quality.md", "scripts/ci-quality.test.ts", "checks/web-leaf.json", "checks/quality-leaf.json"])("JavaScript/documentation input %s needs no Rust compilation", path => {
  expect(needsRust([path])).toBe(false);
});

test.each(["sandbox/src/main.ts", "sandbox/src/editor-pane.tsx", "sandbox/src/startup-output.ts"])("sandbox input %s selects its Browser guest producer without JSC", path => {
  expect(needsRust([path])).toBe(true);
  expect(needsJsc([path])).toBe(false);
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
  mkdirSync(join(fixture, "checks"));
  writeFileSync(join(fixture, "checks/native-json-fast-iterative.json"), readFileSync(new URL("../checks/native-json-fast-iterative.json", import.meta.url), "utf8"));
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

function selectionOutput(start: string, end: string, event = "pull_request"): string {
  return execFileSync("bun", [join(import.meta.dir, "ci-changes.ts"), start, end], {
    cwd: fixture, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: event }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function select(start: string, end: string, event = "pull_request"): string {
  return selectionOutput(start, end, event).split("\n").slice(0, 2).join("\n");
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

function commitInput(path: string, content = "changed input\n"): string {
  if (!fixture) throw new Error("Fixture not initialized");
  git(["checkout", "-q", "--detach", base]);
  mkdirSync(join(fixture, path, ".."), { recursive: true });
  writeFileSync(join(fixture, path), content);
  git(["add", "."]);
  git(["commit", "-qm", `change ${path}`]);
  return git(["rev-parse", "HEAD"]);
}

for (const path of [
  "scripts/jsc-json-fast-controls.test.ts", "checks/runtime-json-fast-controls.json",
  "scripts/bench-jsc-json.ts", "scripts/fixtures/jsc-json-bench.ts",
  "tests/fixtures/json-fast-iterative/index.ts", "tests/fixtures/json-fast-iterative/expected.txt",
  "checks/native-json-fast-iterative.json", "jsc/webkit-wasi.patch", "crates/bunwasm-jsc/cpp/helpers.cpp",
]) {
  test.each(["pull_request", "push"])(`${path} selects the compiled JSON controls' JSC producer for %s`, event => {
    const content = path.endsWith(".json")
      ? readFileSync(new URL(`../${path}`, import.meta.url), "utf8") + "\n" : "changed input\n";
    expect(select(base, commitInput(path, content), event)).toBe("rust=true\njsc=true");
  });
}

for (const path of ["jsc/wasi-jsc.cmake", "tests/fixtures/runtime-proc-spawn-requests.json", "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh", ".github/actions/jsc-setup/action.yml", ".github/actions/jsc-prebuild/action.yml", ".github/workflows/jsc-prebuild.yml"]) {
  test.each(["pull_request", "push"])(`${path} retains native checks through the real %s event CLI`, event => {
    expect(select(base, commitInput(path), event)).toBe(`rust=true\njsc=${needsJsc([path])}`);
  });
}

test.each(["pull_request", "push"])("shared proof changes select only the dedicated job through a real %s diff", event => {
  expect(selectionOutput(base, commitInput("scripts/shared-sysroot-proof.ts"), event))
    .toBe("rust=false\njsc=false\nshared=true\nshared_native=false");
  expect(selectionOutput(base, commitInput("docs/code-quality.md"), event))
    .toBe("rust=false\njsc=false\nshared=false\nshared_native=false");
});

const workflow = expandedCiWorkflow();
const quality = workflow.split("\n  quality:\n")[1]!.split("\n  jsc-identity:\n")[0]!;

for (const path of ["scripts/check-encoded-slice.ts", "tests/encoded-slice/probe.rs"]) {
  test.each(["pull_request", "push"])(`${path} selects the blocking EncodedSlice native proof for %s`, event => {
    expect(needsRust([path])).toBe(true);
    expect(needsJsc([path])).toBe(false);
    expect(select(base, commitInput(path), event)).toBe("rust=true\njsc=false");
  });
}

test("the EncodedSlice proof blocks native CI once after existing tool and vendor setup", () => {
  const rust = workflow.split("\n  native-quality:\n")[1]!.split("\n  rust:\n")[0]!;
  const name = "      - name: Blocking EncodedSlice address regression";
  const step = rust.split(name)[1]?.split("\n      - ")[0];
  expect(step?.trim()).toBe("run: |\n          source env.sh\n          bun scripts/check-encoded-slice.ts");
  expect(workflow.match(/bun scripts\/check-encoded-slice\.ts/g)).toHaveLength(1);
  for (const prerequisite of ["targets: wasm32-wasip1", "name: Install pinned Wasmtime", "name: Prepare pinned upstream sources"]) {
    expect(rust.indexOf(prerequisite)).toBeGreaterThan(-1);
    expect(rust.indexOf(name)).toBeGreaterThan(rust.indexOf(prerequisite));
  }
  expect(rust).not.toMatch(/^    continue-on-error:/m);
});
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
  mkdirSync(join(fixture, "checks"), { recursive: true });
  writeFileSync(join(fixture, "checks/native-shared-release.json"), JSON.stringify({ owner: "native", path: "tests/fixtures/shared-release", profile: "shared-group" }));
  git(["add", "."]);
  git(["commit", "-qm", "manifest inputs"]);
  const manifestBase = git(["rev-parse", "HEAD"]);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "0.0.2", scripts: { quality: "bun quality.ts" } }));
  git(["commit", "-qam", "patch bump"]);
  const bumped = git(["rev-parse", "HEAD"]);
  expect(select(manifestBase, bumped)).toBe("rust=false\njsc=false");
  expect(select(manifestBase, bumped, "push")).toBe("rust=false\njsc=false");
  expect(selectionOutput(manifestBase, bumped)).toEndWith("shared_native=false");
  expect(selectionOutput(manifestBase, bumped, "push")).toEndWith("shared_native=false");
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ version: "0.0.3", scripts: { quality: "bun changed-quality.ts" } }));
  git(["commit", "-qam", "change native driver"]);
  expect(select(bumped, git(["rev-parse", "HEAD"]))).toBe("rust=true\njsc=false");
  expect(selectionOutput(bumped, git(["rev-parse", "HEAD"]))).toEndWith("shared_native=true");
  expect(() => select(first, bumped)).toThrow();
});

for (const path of [
  "scripts/ci-jsc-artifact.ts",
  "jsc/webkit-wasi.patch", "crates/bunwasm-jsc/cpp/helpers.cpp", "scripts/jsc-embedding.ts",
  "scripts/jsc-cloop-frame.ts", "scripts/src/wasm-code.ts",
  "crates/bunwasm-engine-quickjs/src/program.rs", "crates/bunwasm-engine-quickjs/src/loader.rs", "crates/bunwasm-engine-quickjs/src/value_natives.rs",
  "crates/bunwasm-engine-quickjs/src/driver.rs", "crates/bunwasm-engine-quickjs/src/client.rs", "crates/bunwasm-engine-quickjs/src/natives.rs", "crates/bunwasm-engine-quickjs/src/allocator.rs", "crates/bunwasm-engine-quickjs/src/transport.rs", "crates/bunwasm-engine-quickjs/src/side_modules.rs",
  "crates/bunwasm-engine-jsc/src/lib.rs", "scripts/build-bun-jsc.sh", "scripts/build-engine-jsc.sh", "scripts/build-engine-quickjs.sh", "scripts/build-bun-core.sh", "scripts/build.sh", "scripts/quickjs-core-exports.txt",
  "scripts/guest-artifact.ts", "scripts/guest-build-receipt.ts", "scripts/guest-core-receipt.ts", "scripts/guest-engine-receipt.ts", "scripts/guest-source-manifest.ts", "scripts/guest-acceptance.ts",
  "scripts/src/engine-explicit-init.ts", "scripts/src/engine-init.c", "scripts/engine-producer.test.ts", "scripts/src/engine-explicit-init.test.ts",
  "src/engine-kind.ts", "src/assets.ts", "src/quickjs-program.ts", "web/src/engine-loader.ts",
  "scripts/bench-jsc.sh", "scripts/ci-binaryen.ts", "scripts/ci-build-tools.ts", "tests/fixtures/shared-array-buffer/index.ts", "tests/jsc-embedding/growable-memory/index.ts",
  "tests/fixtures/strings-above-512mib/index.ts", "crates/bunwasm-cli/max-memory.txt",
  "web/scripts/node-host.ts", "web/scripts/node-worker.ts", "web/guest-tests/compose.ts", "web/src/net/trampoline.ts", "web/bun.lock",
  "web/src/native-direct-stream.ts", "web/src/native-readable-iterator.ts",
  "crates/bunwasm-runtime/src/host.rs", "scripts/test-web-guests.ts",
  "scripts/sync-bun.sh", "scripts/sync-crypto.sh", "tests/fixtures/runtime-proc-spawn-requests.json",
]) {
  test.each(["pull_request", "push"])(`${path} selects actual JSC embedding execution for %s`, event => {
    expect(needsJsc([path])).toBe(true);
    expect(select(base, commitInput(path), event)).toBe("rust=true\njsc=true");
  });
}

for (const [path, fixture] of [
  ["checks/native-stack-getter-headroom.json", "tests/fixtures/stack-getter-headroom"],
  ["tests/fixtures/stack-getter-headroom/index.ts", ""],
  ["tests/fixtures/stack-getter-headroom/expected.txt", ""],
  ["checks/native-getter-dispatch.json", "tests/fixtures/getter-dispatch"],
  ["tests/fixtures/getter-dispatch/index.ts", ""],
  ["checks/native-proxy-get-forwarding.json", "tests/fixtures/proxy-get-forwarding"],
  ["tests/fixtures/proxy-get-forwarding/index.ts", ""],
  ["tests/fixtures/proxy-get-forwarding/expected.txt", ""],
  ["checks/native-parser-literal-overflow.json", "tests/fixtures/parser-literal-overflow"],
  ["tests/fixtures/parser-literal-overflow/index.ts", ""],
  ["checks/native-assignment-chain-depth.json", "tests/fixtures/assignment-chain-depth"],
  ["tests/fixtures/assignment-chain-depth/index.ts", ""],
  ["checks/native-statement-record-cap.json", "tests/fixtures/statement-record-cap"],
  ["tests/fixtures/statement-record-cap/index.ts", ""],
  ["checks/native-statement-records-async-using.json", "tests/fixtures/statement-records-async-using"],
  ["tests/fixtures/statement-records-async-using/index.ts", ""],
] as const) {
  test.each(["pull_request", "push"])(`${path} retains the strict JSC stack embedding gate for %s`, event => {
    const content = fixture ? JSON.stringify({ owner: "native", path: fixture }) : "changed stack fixture input\n";
    expect(select(base, commitInput(path, content), event)).toBe("rust=true\njsc=true");
    expect(needsJsc([path])).toBe(true);
  });
}

test("similarly named stack fixtures do not select the JSC producer", () => {
  expect(needsJsc(["checks/native-stack-getter-headroom-extra.json", "tests/fixtures/stack-getter-headroom-extra/index.ts"])).toBe(false);
});

test("unrelated page changes skip JSC; its selected gate builds and executes once", () => {
  expect(needsJsc(["web/src/page.ts", "docs/jsc-build.md"])).toBe(false);
  expect(workflow).toContain("if: needs.quality.outputs.jsc == 'true'");
  expect(workflow.match(/^\s+bash scripts\/build-jsc\.sh$/gm)).toHaveLength(1);
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

for (const event of ["pull_request", "push"]) {
  test(`dormant Hermes recipes do not select native production through an actual ${event} diff`, () => {
    for (const path of ["hermes/build.sh", "docs/hermes-engine.md", "tests/hermes/run.sh", "tests/hermes/promise-ownership.test.ts", "scripts/fixtures/hermes-promise/01-Promise.js.txt"]) {
      expect(selectionOutput(base, commitInput(path), event))
        .toBe("rust=false\njsc=false\nshared=false\nshared_native=false");
    }
  });
}

test("TLS live inputs select native prerequisites while lightweight-only utility edits do not", () => {
  for (const path of ["scripts/tls-probe.ts", "scripts/tls-probe-cargo.ts", "scripts/tls-probe-handoff.ts", "tests/native/tls-probe.cpp", "checks/native-probe-tls.json"]) expect(needsRust([path])).toBe(true);
  expect(needsRust(["scripts/tls-probe.test.ts"])).toBe(false);
});

function sharedBrowserSelection(path: string, event: string): string {
  if (!fixture) throw new Error("Fixture not initialized");
  git(["checkout", "-q", "--detach", base]);
  mkdirSync(join(fixture, "checks"), { recursive: true });
  writeFileSync(join(fixture, "checks/native-shared-browser.json"), JSON.stringify({ owner: "native", path: "tests/fixtures/shared-browser", profile: "shared-group" }));
  git(["add", "."]);
  git(["commit", "-qm", "existing shared profile"]);
  const start = git(["rev-parse", "HEAD"]);
  mkdirSync(join(fixture, path, ".."), { recursive: true });
  writeFileSync(join(fixture, path), "changed shared Browser input\n");
  git(["add", "."]);
  git(["commit", "-qm", `change ${path}`]);
  return selectionOutput(start, git(["rev-parse", "HEAD"]), event);
}

for (const path of [
  "web/src/runner.ts", "web/src/worker.ts", "web/src/subprocess-broker.ts",
  "web/src/memory-telemetry.ts", "web/src/net/trampoline.ts", "src/assets.ts",
  "scripts/browser-build.ts", "web/package.json", "web/bun.lock",
]) {
  test.each(["pull_request", "push"])(`${path} selects the real shared consumer and launcher for %s`, event => {
    const output = sharedBrowserSelection(path, event);
    expect(output).toStartWith("rust=true\n");
    expect(output).toEndWith("shared_native=true");
  });
}


test("shared engine bridge and errno adapter inputs retain their JSC and shared gates", () => {
  for (const path of ["scripts/src/group-errno-wraps.sh", "crates/bunwasm-engine-quickjs/src/nested_bridge.rs", "crates/bunwasm-engine-quickjs/src/nested_token.rs", "crates/bunwasm-engine-quickjs/group-errno.c"]) {
    expect(needsJsc([path])).toBe(true);
    expect(needsRust([path])).toBe(true);
    expect(needsSharedNative([path])).toBe(true);
  }
});

for (const path of [
  "crates/bunwasm-runtime/src/install/resolve/tarball.rs", "tests/install/registry.mjs",
  "scripts/install-tarballs.test.ts", "scripts/install-metadata.test.ts",
  "scripts/install-fixture-command.ts", "scripts/install-fixture-command.test.ts",
  "scripts/install-download-fixture.ts", "scripts/install-demand-fixture.ts",
  "checks/runtime-install-tarballs.json", "checks/runtime-install-metadata.json",
  "checks/quality-install-fixture-command.json",
]) {
  test.each(["pull_request", "push"])(`${path} selects all installer producers for %s`, event => {
    const content = path.startsWith("checks/") ? readFileSync(new URL(`../${path}`, import.meta.url), "utf8") : "changed installer input\n";
    expect(needsJsc([path])).toBe(true);
    expect(select(base, commitInput(path, content), event)).toBe("rust=true\njsc=true");
  });
}

for (const path of [
  "spidermonkey/common.sh", "spidermonkey/fetch-spidermonkey.sh", "spidermonkey/build-shared-group.sh",
  "spidermonkey/shared-group.ts", "spidermonkey/spidermonkey-shared-group.patch", "spidermonkey/irregexp-icu/allocator.cpp",
  "scripts/build-engine-spidermonkey-shared.sh", "scripts/spidermonkey-side-core-receipt.ts",
]) {
  test.each(["pull_request", "push"])(`${path} selects the existing blocking shared native gate for %s`, event => {
    const output = sharedBrowserSelection(path, event);
    expect(output).toStartWith("rust=true\n");
    expect(output).toEndWith("shared_native=true");
  });
}
