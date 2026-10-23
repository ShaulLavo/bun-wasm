import { execFileSync, spawnSync } from "node:child_process";

const nativeDirectories = ["crates/", "vendor/", "third_party/", "patches/", ".cargo/", "tests/fixtures/node-misc/"];
const nativeFiles = new Set([
  "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "env.sh", "package.json", "bun.lock", ".github/workflows/ci.yml",
  "scripts/quality.ts", "scripts/quality-rust.ts", "scripts/quality-wasi.ts", "scripts/quality-wasi-probe.ts", "scripts/quality-command.ts", "scripts/quality-input-times.ts",
  "jsc/wasi-jsc.cmake", "tests/fixtures/runtime-proc-spawn-requests.json", "scripts/test.sh",
  "scripts/check-cmake-cache.cmake", "scripts/check-wasi-cmake-cache.sh",
  "scripts/ci-changes.ts", "scripts/browser-build.ts", "scripts/guest-build-receipt.ts", "scripts/transpile-runtime.ts",
]);
const nativeScripts = /^scripts\/(?:build[.-]|sync-|export-patches|generate-)/;

export function needsRust(paths: readonly string[]): boolean {
  return paths.some(path => nativeFiles.has(path) || nativeScripts.test(path) || nativeDirectories.some(root => path.startsWith(root)));
}

export function changedPaths(base: string, head: string, pullRequest: boolean): string[] {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) throw new Error("Expected full base and head commit IDs");
  if (/^0+$/.test(base)) return ["Cargo.toml"];
  const range = pullRequest ? `${base}...${head}` : `${base}..${head}`;
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", range], { encoding: "utf8" }).split("\0").filter(Boolean);
}

function manifestInputs(ref: string): string | undefined {
  const result = spawnSync("git", ["show", `${ref}:package.json`], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const manifest: unknown = JSON.parse(result.stdout);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid root package manifest");
  return JSON.stringify(Object.entries(manifest).filter(([key]) => key !== "version"));
}

function nativeChanges(paths: readonly string[], base: string, head: string): string[] {
  if (!paths.includes("package.json")) return paths.filter(path => needsRust([path]));
  const before = manifestInputs(base);
  const after = manifestInputs(head);
  return paths.filter(path => needsRust([path]) && (path !== "package.json" || before === undefined || after === undefined || before !== after));
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Usage: ci-changes.ts <base-sha> <head-sha>");
  const paths = changedPaths(base, head, process.env.GITHUB_EVENT_NAME === "pull_request");
  const native = nativeChanges(paths, base, head);
  console.error(`Native inputs changed: ${native.join(", ") || "none"}`);
  console.log(`rust=${needsRust(native)}`);
}
