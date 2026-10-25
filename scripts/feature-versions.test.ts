import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFeatureVersions, versionRecords } from "./feature-versions";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Version test", "-c", "user.email=ci@localhost"].concat(args), { cwd, encoding: "utf8" }).trim();
}

test("package, workspace, Cargo local-lock and Bun workspace versions retain their exact records", () => {
  expect(versionRecords("package.json", '{\n  "version": "0.0.61",\n  "dependencies": {}\n}\n')).toEqual(['0.0.61']);
  expect(versionRecords("Cargo.toml", '[workspace.package]\nversion = "0.0.61"\n')).toEqual(['version = "0.0.61"']);
  expect(versionRecords("package.json", '{"version":"0.0.61"}')).toEqual(["0.0.61"]);
  expect(versionRecords("Cargo.toml", '[package]\nversion.workspace = true\n')).toEqual(["version.workspace = true"]);
  expect(versionRecords("Cargo.lock", '[[package]]\nname = "bunwasm-runtime"\nversion = "0.0.61"\n[[package]]\nname = "foreign"\nversion = "1"\n')).toEqual(['name = "bunwasm-runtime"\nversion = "0.0.61"']);
  expect(versionRecords("bun.lock", '{\n  "workspaces": {\n    "": {\n      "name": "bun-wasm",\n      "version": "0.0.61",\n    },\n  },\n  "packages": {\n    "version": "dependency version",\n  }\n}')).toEqual(['      "name": "bun-wasm",', '      "version": "0.0.61",']);
});

test("real Git comparison permits command edits but rejects a feature's standalone version churn", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bun-wasm-version-policy-"));
  scratch.push(cwd);
  git(cwd, "init", "-q");
  writeFileSync(join(cwd, "package.json"), '{\n  "version": "0.0.61",\n  "scripts": {}\n}\n');
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "package.json"), '{\n  "version": "0.0.61",\n  "scripts": {"test":"bun test"}\n}\n');
  git(cwd, "commit", "-qam", "commands");
  expect(verifyFeatureVersions(base, git(cwd, "rev-parse", "HEAD"), cwd)).toEqual(["package.json"]);
  writeFileSync(join(cwd, "package.json"), '{\n  "version": "0.0.62",\n  "scripts": {}\n}\n');
  git(cwd, "commit", "-qam", "version churn");
  expect(() => verifyFeatureVersions(base, git(cwd, "rev-parse", "HEAD"), cwd)).toThrow("Feature PR changes version records");
  expect(() => verifyFeatureVersions("HEAD", base, cwd)).toThrow("full base and head");
});

test("a new workspace crate in Cargo.lock is not version churn, a changed one is", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bun-wasm-version-policy-"));
  scratch.push(cwd);
  git(cwd, "init", "-q");
  const lock = (records: string) => writeFileSync(join(cwd, "Cargo.lock"), records);
  lock('[[package]]\nname = "bunwasm-runtime"\nversion = "0.0.61"\n');
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  lock('[[package]]\nname = "bunwasm-hermes"\nversion = "0.0.61"\n[[package]]\nname = "bunwasm-runtime"\nversion = "0.0.61"\n');
  git(cwd, "commit", "-qam", "new crate");
  expect(verifyFeatureVersions(base, git(cwd, "rev-parse", "HEAD"), cwd)).toEqual(["Cargo.lock"]);
  lock('[[package]]\nname = "bunwasm-hermes"\nversion = "0.0.62"\n[[package]]\nname = "bunwasm-runtime"\nversion = "0.0.62"\n');
  git(cwd, "commit", "-qam", "bump");
  expect(() => verifyFeatureVersions(base, git(cwd, "rev-parse", "HEAD"), cwd)).toThrow("Feature PR changes version records");
});

test("normal feature CI runs the version guard, with deliberate release and consumer-pin exceptions", () => {
  const workflow = Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url));
  return workflow.text().then(source => {
    expect(source).toContain('run: bun scripts/feature-versions.ts "$BASE" "$HEAD"');
    expect(source).toContain("!contains(github.event.pull_request.labels.*.name, 'release')");
    expect(source).toContain("!contains(github.event.pull_request.labels.*.name, 'consumer-pin')");
  });
});
