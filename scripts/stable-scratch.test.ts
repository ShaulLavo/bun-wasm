import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableScratch } from "./stable-scratch.ts";

// Some tests here list the whole repository. The limit only catches a hang.
setDefaultTimeout(60_000);

const root = join(import.meta.dir, "..");
const originalRunnerTemp = process.env.RUNNER_TEMP;
const cleanup: string[] = [];

afterEach(() => {
  if (originalRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
  else process.env.RUNNER_TEMP = originalRunnerTemp;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("outside CI, two runs of the same check get separate scratch directories", () => {
  delete process.env.RUNNER_TEMP;
  const first = stableScratch("concurrent-control");
  const second = stableScratch("concurrent-control");
  cleanup.push(first, second);
  expect(second).not.toBe(first);
  expect(first.startsWith(tmpdir())).toBe(true);
  // The second run's setup must not delete what the first run already built.
  writeFileSync(join(first, "target-marker"), "built");
  const third = stableScratch("concurrent-control");
  cleanup.push(third);
  expect(readFileSync(join(first, "target-marker"), "utf8")).toBe("built");
  expect(existsSync(join(second, "target-marker"))).toBe(false);
});

test("in CI, the scratch path stays fixed per check name so sccache keeps hitting", () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "bun-wasm-stable-scratch-control-"));
  cleanup.push(runnerTemp);
  process.env.RUNNER_TEMP = runnerTemp;
  const first = stableScratch("ci-control");
  writeFileSync(join(first, "stale"), "left over");
  const second = stableScratch("ci-control");
  expect(second).toBe(first);
  expect(first).toBe(join(runnerTemp, "bun-wasm-stable-scratch", "ci-control"));
  expect(existsSync(join(second, "stale"))).toBe(false);
});

test("scratch names are restricted", () => {
  expect(() => stableScratch("../escape")).toThrow("Invalid stable scratch name");
});

// A new check that builds in a fixed shared directory would make parallel lanes delete each
// other's Cargo target again. Fixed paths go through stableScratch (or mkdtemp), never by hand.
test("no source builds in a hand-written fixed scratch path", () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.ts"], { cwd: root, stdout: "pipe" });
  expect(listed.exitCode).toBe(0);
  const files = listed.stdout.toString().split("\0").filter(file => file && !file.startsWith("vendor/") && !file.startsWith("third_party/"));
  const allowedStableLiteral = new Set(["scripts/stable-scratch.ts", "scripts/stable-scratch.test.ts"]);
  // A path that is meant never to exist, so nothing is ever written there.
  const nonexistentPaths = new Set(["web/tests/page-load-profile.test.ts"]);
  const fixedTmpdirJoin =/\b(?:join|resolve)\((?:os\.)?tmpdir\(\),\s*(["'`])[^"'`$]*\1\)/;
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      if (line.includes("bun-wasm-stable-scratch") && !allowedStableLiteral.has(file)) found.push(`${where}: use stableScratch()`);
      if (fixedTmpdirJoin.test(line) && !/mkdtemp/.test(line) && !/ci-temp-guard/.test(file) && !nonexistentPaths.has(file)) found.push(`${where}: fixed path under tmpdir(); use mkdtemp or stableScratch()`);
    });
  }
  expect(found).toEqual([]);
});
