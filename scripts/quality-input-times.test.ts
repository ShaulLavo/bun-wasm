import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preserveInputTimes } from "./quality-input-times";

function withInputs(check: (root: string, receipt: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-ci-input-times-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/input.txt"), "original");
    check(root, join(root, "receipt.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unchanged files and directories regain cached timestamps after checkout", () => {
  withInputs((root, receipt) => {
    preserveInputTimes(root, receipt, ["src"]);
    const expected = statSync(join(root, "src/input.txt")).mtimeMs;
    utimesSync(join(root, "src/input.txt"), 1, (expected + 60000) / 1000);
    utimesSync(join(root, "src"), 1, (expected + 60000) / 1000);
    preserveInputTimes(root, receipt, ["src"]);
    expect(statSync(join(root, "src/input.txt")).mtimeMs).toBeCloseTo(expected, 1);
    expect(statSync(join(root, "src")).mtimeMs).toBeCloseTo(expected, 1);
  });
});

test("changed content is fresh even when an archive supplied an old timestamp", () => {
  withInputs((root, receipt) => {
    preserveInputTimes(root, receipt, ["src"]);
    writeFileSync(join(root, "src/input.txt"), "changed");
    utimesSync(join(root, "src/input.txt"), 1, 1);
    preserveInputTimes(root, receipt, ["src"]);
    expect(statSync(join(root, "src/input.txt")).mtimeMs).toBeGreaterThan(Date.now() - 1000);
    expect(readFileSync(join(root, "src/input.txt"), "utf8")).toBe("changed");
  });
});

test("renames, additions and deletions change directory fingerprints", () => {
  withInputs((root, receipt) => {
    preserveInputTimes(root, receipt, ["src"]);
    const before = readFileSync(receipt, "utf8");
    renameSync(join(root, "src/input.txt"), join(root, "src/renamed.txt"));
    writeFileSync(join(root, "src/new.txt"), "new");
    preserveInputTimes(root, receipt, ["src"]);
    expect(readFileSync(receipt, "utf8")).not.toBe(before);
    rmSync(join(root, "src/renamed.txt"));
    preserveInputTimes(root, receipt, ["src"]);
    expect(readFileSync(receipt, "utf8")).not.toContain("renamed.txt");
  });
});

test("symlink timestamps do not rewrite the target", () => {
  withInputs((root, receipt) => {
    writeFileSync(join(root, "outside.txt"), "outside");
    utimesSync(join(root, "outside.txt"), 1, 1);
    symlinkSync("../outside.txt", join(root, "src/link.txt"));
    preserveInputTimes(root, receipt, ["src"]);
    expect(statSync(join(root, "outside.txt")).mtimeMs).toBe(1000);
  });
});

test("invalid cached receipts fail instead of masking changed inputs", () => {
  withInputs((root, receipt) => {
    writeFileSync(receipt, '{"unexpected":true}');
    expect(() => preserveInputTimes(root, receipt, ["src"])).toThrow("Invalid input-time receipt");
    writeFileSync(receipt, '[["src", "hash", "not a number"]]');
    expect(() => preserveInputTimes(root, receipt, ["src"])).toThrow("Invalid input-time entry");
  });
});
