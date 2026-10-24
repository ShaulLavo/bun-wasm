import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { automaticChecks, checkBatches, discoverChecks, selectChecks } from "../test-checks";
import { migrationBase } from "./split-bun-patches";

const root = resolve(import.meta.dir, "../..");

function before(path: string): string {
  return execFileSync("git", ["show", `${migrationBase}:${path}`], { cwd: root, encoding: "utf8" });
}

export function oldSelections() {
  const runtime = Array.from(before("scripts/check-runtime.sh").matchAll(/\$root\/(scripts\/[^" ]+\.test\.ts)/g), match => match[1]!);
  const web = Array.from(before("scripts/test-web-host.sh").matchAll(/\.\.\/(scripts\/[^\s]+\.test\.ts)/g), match => match[1]!);
  const quality = Array.from(before("package.json").matchAll(/"quality:probes": "([^"]+)"/g), match => match[1]!).flatMap(command => command.split(" ").slice(2));
  const imported = Array.from(before("scripts/quality-probes.test.ts").matchAll(/^import "\.\/(.+\.test\.ts)";/gm), match => `scripts/${match[1]}`);
  const workflow = before(".github/workflows/ci.yml");
  const native = workflow.match(/bash scripts\/test.sh --no-build ([^\n]+)/)?.[1]?.split(" ").map(name => `tests/fixtures/${name}`);
  const packageExtra = workflow.match(/run: bun test (scripts\/node-fs-readv[^\n]+)/)?.[1]?.split(" ");
  if (!native || !packageExtra) throw new Error("Missing original fixture/package selections");
  return { runtime, web: web.filter(path => path !== "scripts/run-with-timeout-browser.test.ts"), quality: quality.concat(imported), "package-extra": packageExtra,
    native, cmake: ["scripts/cmake-cache.test.ts"], "web-browser": ["scripts/run-with-timeout-browser.test.ts"] };
}

export function oldWebBatches(): string[][] {
  return Array.from(before("scripts/test-web-host.sh").matchAll(/^    bun test (.+)$/gm), match => Array.from(match[1]!.matchAll(/\.\.\/(scripts\/[^\s]+\.test\.ts)/g), item => item[1]!)).map(paths => paths.sort());
}

export function migratedChecks() {
  const selections = oldSelections();
  const webBatches = oldWebBatches();
  return Object.entries(selections).flatMap(([owner, paths]) => paths.filter(path => owner !== "runtime" || !selections.web.includes(path))
    .map(path => ({ owner, path, ...(selections.runtime.includes(path) ? { localRuntime: true } : {}), ...(owner === "web" ? { batch: `${webBatches.findIndex(paths => paths.includes(path)) + 10}-web` } : {}) })));
}

export function proveCheckMigration() {
  const selections = oldSelections();
  const originalPaths = new Set(Object.values(selections).flat());
  const checks = discoverChecks(root);
  for (const [owner, paths] of Object.entries(selections)) {
    const expected = owner === "runtime" ? paths.filter(path => !selections.web.includes(path)) : paths;
    const baseline = selectChecks(owner, checks).filter(path => originalPaths.has(path));
    if (JSON.stringify(baseline) !== JSON.stringify(expected.toSorted())) throw new Error(`Selection drift: ${owner}`);
  }
  if (JSON.stringify(selectChecks("local-runtime", checks).filter(path => originalPaths.has(path))) !== JSON.stringify(selections.runtime.toSorted())) throw new Error("Local runtime selection drift");
  const batches = checkBatches("web", checks).map(paths => paths.filter(path => originalPaths.has(path))).filter(paths => paths.length);
  if (JSON.stringify(batches) !== JSON.stringify(oldWebBatches())) throw new Error("Web command batch drift");
  const baselineWeb = JSON.parse(before("web/package.json")).scripts.test;
  const baselinePackage = JSON.parse(before("package.json")).scripts.test;
  if (JSON.parse(readFileSync(resolve(root, "web/package.json"), "utf8")).scripts.test !== baselineWeb) throw new Error("Web automatic selection drift");
  if (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts.test !== baselinePackage) throw new Error("Package automatic selection drift");
  return { base: migrationBase, explicit: checks, automatic: automaticChecks(root), webBatches: batches, deduplicated: selections.runtime.filter(path => selections.web.includes(path)) };
}


if (import.meta.main) {
  const [mode] = process.argv.slice(2);
  if (mode === "--write") {
    mkdirSync(resolve(root, "checks"), { recursive: true });
    for (const check of migratedChecks()) {
      const stem = check.path.replace(/^scripts\//, "").replace(/^tests\/fixtures\//, "").replace(/\.test\.ts$/, "").replaceAll("/", "-");
      writeFileSync(resolve(root, `checks/${check.owner}-${stem}.json`), JSON.stringify(check, null, 2) + "\n");
    }
  } else if (mode !== "--check") throw new Error("Usage: discover-checks.ts --write|--check");
  console.log(JSON.stringify(proveCheckMigration(), null, 2));
}
