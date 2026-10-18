import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, needsRust } from "./ci-changes";

test.each([
  "crates/bunwasm-runtime/src/lib.rs", "vendor/bun/src/parser.rs", "patches/bun/001.patch",
  "third_party/libc/src/lib.rs", "Cargo.lock", "Cargo.toml", ".cargo/config.toml", "rust-toolchain.toml",
  "env.sh", "scripts/build-wasi-sysroot.ts", "scripts/sync-crypto.sh", "scripts/quality-rust.ts",
  "scripts/quality-wasi-probe.ts", "scripts/quality.ts", "scripts/ci-changes.ts", "package.json", "bun.lock",
  ".github/workflows/ci.yml",
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
