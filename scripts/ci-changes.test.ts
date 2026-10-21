import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, needsRust } from "./ci-changes";

test.each([
  "jsc/wasi-jsc.cmake", "tests/fixtures/runtime-proc-spawn-requests.json",
  "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh",
  "crates/bunwasm-runtime/src/lib.rs", "vendor/bun/src/parser.rs", "patches/bun/001.patch",
  "third_party/libc/src/lib.rs", "Cargo.lock", "Cargo.toml", ".cargo/config.toml", "rust-toolchain.toml",
  "env.sh", "scripts/build-wasi-sysroot.ts", "scripts/sync-crypto.sh", "scripts/quality-rust.ts",
  "scripts/quality-wasi-probe.ts", "scripts/quality.ts", "scripts/ci-changes.ts", "package.json", "bun.lock",
  ".github/workflows/ci.yml", "scripts/build.sh", "scripts/browser-build.ts", "scripts/guest-build-receipt.ts", "scripts/transpile-runtime.ts",
])("native input %s retains every Rust gate", path => {
  expect(needsRust([path])).toBe(true);
});

test.each(["src/index.ts", "web/src/worker.ts", "sandbox/src/main.ts", "site/src/main.ts", "docs/code-quality.md", "scripts/ci-quality.test.ts"])("JavaScript/documentation input %s needs no Rust compilation", path => {
  expect(needsRust([path])).toBe(false);
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
  expect(select(base, native)).toBe("rust=true");
  expect(select(native, javascript)).toBe("rust=false");
});

test("multi-commit main push includes earlier native changes", () => {
  expect(select(base, javascript, "push")).toBe("rust=true");
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
    expect(select(base, commitInput(path), event)).toBe("rust=true");
  });
}

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const quality = workflow.split("\n  quality:\n")[1]!.split("\n  rust:\n")[0]!;
for (const path of [
  "scripts/cmake-cache.test.ts", "scripts/run-with-timeout.mts", "jsc/configure.sh", "jsc/build.sh", "jsc/common.sh",
  "scripts/real-runtime-network-tls.sh", "jsc/shim/wasi-compat.h", "jsc/shim/wasi-compat.c", "jsc/shim/madvise.c",
]) {
  test.each(["pull_request", "push"])(`${path} keeps the blocking lightweight CMake owner for a real %s event`, event => {
    expect(select(base, commitInput(path), event)).toBe("rust=false");
    expect(quality).toContain("run: bun test scripts/cmake-cache.test.ts");
    expect(quality).not.toMatch(/^\s+(?:if|needs):/m);
  });
}

test.each([
  "scripts/node-fs-streams.test.ts", "scripts/node-vm-context.test.ts", "scripts/node-http-headers.test.ts", "scripts/node-http-response-fixture.ts",
  "scripts/test.sh", "scripts/check-runtime.sh", "tests/servers/http.ts",
  "tests/fixtures/stdio-cursor/source-probe.ts", "tests/fixtures/stdio-cursor/expected_stderr.txt",
  "tests/fixtures/fs-stream-constructors/contract.ts", "tests/fixtures/vm-context/contract.ts",
  "tests/fixtures/module-compile/index.ts", "tests/fixtures/net-http-implicit-headers/contract.ts",
])("new native fixture input %s selects the existing native job", path => {
  expect(needsRust([path])).toBe(true);
});

test.each([
  "web/tests/next-framework-browser.ts", "web/tests/preview-policy.test.ts", "docs/framework-routes.md",
  "scripts/node-http-headers.test.ts.md", "tests/fixtures-docs/module-compile.md", "tests/servers-docs/http.md",
  "tests/fixtures/unregistered-guest/index.ts",
])("host or neighboring input %s does not add a native job", path => {
  expect(needsRust([path])).toBe(false);
});


for (const path of ["scripts/node-fs-streams.test.ts", "tests/fixtures/vm-context/contract.ts", "scripts/node-http-response-fixture.ts"]) {
  test.each(["pull_request", "push"])(`${path} selects native gates through the real %s event CLI`, event => {
    expect(select(base, commitInput(path), event)).toBe("rust=true");
  });
}


test("each registered native guest fixture selects its existing job", () => {
  const command = workflow.match(/bash scripts\/test\.sh --no-build ([^\n]+)/)?.[1];
  expect(command).toBeDefined();
  if (!command) throw new Error("Native fixture command missing");
  for (const name of command.trim().split(/\s+/)) expect(needsRust([`tests/fixtures/${name}/changed-input.ts`])).toBe(true);
});
