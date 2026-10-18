import { execFileSync } from "node:child_process";

const nativeInputs = /^(?:crates\/|vendor\/|third_party\/|patches\/|\.cargo\/|Cargo\.[^/]+$|rust-toolchain(?:\.toml)?$|env\.sh$|package\.json$|bun\.lock$|\.github\/workflows\/ci\.yml$|scripts\/(?:build-|sync-|export-patches|generate-|quality(?:-rust|-wasi|-wasi-probe|-command)?\.ts$|ci-changes\.ts$))/;

export function needsRust(paths: readonly string[]): boolean {
  return paths.some(path => nativeInputs.test(path));
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
