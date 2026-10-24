import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyFeatureVersions } from "../feature-versions";
import { migrationBase, migrationOutputs } from "./split-bun-patches";
import { proveCheckMigration } from "./discover-checks";

const root = resolve(import.meta.dir, "../..");
function git(args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }

if (import.meta.main) {
  const [head] = process.argv.slice(2);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) throw new Error("Usage: prove-landing.ts <full-head-sha>");
  if (git(["rev-parse", "HEAD"]) !== head || git(["status", "--porcelain"])) throw new Error("Proof requires the exact clean checked-out head");
  const protectedPaths = ["crates", "src", "web", "sandbox", "site", "tests", "patches", "third_party", "jsc", "Cargo.toml", "Cargo.lock", "bun.lock", "env.sh", "rust-toolchain.toml"];
  const protectedTrees = protectedPaths.map(path => {
    const baseObject = git(["rev-parse", `${migrationBase}:${path}`]);
    const headObject = git(["rev-parse", `${head}:${path}`]);
    if (baseObject !== headObject) throw new Error(`Protected source or pin changed: ${path}`);
    return { path, object: headObject };
  });
  const packages = [migrationBase, head].map(ref => JSON.parse(git(["show", `${ref}:package.json`])));
  const withoutScripts = packages.map(manifest => Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "scripts")));
  if (JSON.stringify(withoutScripts[0]) !== JSON.stringify(withoutScripts[1])) throw new Error("Root package changed outside command wiring");
  const versions = verifyFeatureVersions(migrationBase, head);
  const documents = migrationOutputs(root);
  for (const [path, text] of documents.files) if (readFileSync(resolve(root, path), "utf8") !== text) throw new Error(`Content/link migration differs: ${path}`);
  const discovery = proveCheckMigration();
  console.log(JSON.stringify({ base: migrationBase, head, protectedTrees, versions,
    documents: { sections: documents.sectionCount, classifiedRows: documents.rowCount, anchors: documents.anchors.size }, discovery }, null, 2));
}
