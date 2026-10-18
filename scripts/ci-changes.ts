import { execFileSync } from "node:child_process";

const nativeDirectories = ["crates/", "vendor/", "third_party/", "patches/", ".cargo/"];
const nativeFiles = new Set([
  "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "env.sh", "package.json", "bun.lock", ".github/workflows/ci.yml",
  "scripts/quality.ts", "scripts/quality-rust.ts", "scripts/quality-wasi.ts", "scripts/quality-wasi-probe.ts", "scripts/quality-command.ts",
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

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Usage: ci-changes.ts <base-sha> <head-sha>");
  const paths = changedPaths(base, head, process.env.GITHUB_EVENT_NAME === "pull_request");
  console.error(`Native inputs changed: ${paths.filter(path => needsRust([path])).join(", ") || "none"}`);
  console.log(`rust=${needsRust(paths)}`);
}
