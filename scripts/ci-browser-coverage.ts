import { execFileSync } from "node:child_process";
import { changedPaths } from "./ci-changes";
import { coverageBatches, type BrowserGuestSelection } from "./browser-guest-catalogue";
import { selectBrowserGuestCoverage, type CoverageManifestSnapshot } from "./browser-guest-selection";
import { namedCheckBatches } from "./test-checks";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5_000 }).trim();
}
export function browserCoverageSnapshot(ref: string, role: CoverageManifestSnapshot["role"], cwd = process.cwd()): CoverageManifestSnapshot {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("Expected full coverage snapshot commit");
  if (/^0+$/.test(ref)) return { ref, role, manifests: [] };
  const directory = git(["ls-tree", ref, "--", "checks"], cwd);
  if (!directory) return { ref, role, manifests: [] };
  if (!/^040000 tree [a-f0-9]{40}\tchecks$/.test(directory)) throw new Error("Unsafe coverage check directory");
  const entries = git(["ls-tree", "-r", ref, "--", "checks"], cwd).split("\n");
  const manifests = entries.filter(entry => /\tchecks\/browser-guest-/.test(entry)).map(entry => {
    const match = /^(?:100644|100755) blob ([a-f0-9]{40})\t(checks\/[a-z0-9-]+\.json)$/.exec(entry);
    const [, object, file] = match ?? [];
    if (!object || !file) throw new Error("Unsafe coverage manifest");
    return { file, value: JSON.parse(git(["cat-file", "blob", object], cwd)) };
  });
  return { ref, role, manifests };
}
export function selectCiBrowserCoverage(base: string, head: string, options: { pullRequest: boolean; full: boolean }): BrowserGuestSelection {
  const ancestor = options.pullRequest && !/^0+$/.test(base) ? git(["merge-base", base, head], process.cwd()) : base;
  return selectBrowserGuestCoverage({ changedPaths: changedPaths(base, head, options.pullRequest), full: options.full,
    snapshots: [browserCoverageSnapshot(base, "base"), browserCoverageSnapshot(head, "head"), browserCoverageSnapshot(ancestor, "merge-ancestor")] });
}
export function browserCoverageOutputs(selection: BrowserGuestSelection): string {
  const selected = new Set<string>(selection.map(item => coverageBatches[item.owner]));
  const batches = namedCheckBatches("browser-guest").filter(batch => !Object.values(coverageBatches).some(name => name === batch.name) || selected.has(batch.name));
  return [`batches=${JSON.stringify(batches.map(batch => batch.name))}`, `selection=${JSON.stringify(selection)}`,
    `rust=${selection.length > 0}`, `jsc=${selection.some(item => item.engines.includes("jsc"))}`].join("\n");
}
if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Usage: ci-browser-coverage.ts <base-sha> <head-sha>");
  console.log(browserCoverageOutputs(selectCiBrowserCoverage(base, head, {
    pullRequest: process.env.GITHUB_EVENT_NAME === "pull_request", full: process.env.BROWSER_COVERAGE_FULL === "true" || process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
  })));
}
