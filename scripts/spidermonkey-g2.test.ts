import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compileArguments, parseCommands } from "../spidermonkey/rebuild-g2.ts";

test("G2 compiler replay changes only source, output and the embed macro", () => {
  const entry = { directory: "/obj", file: "/source/vm.cpp", arguments: ["clang++", "--sysroot", "/sysroot", "-fPIC", "-fno-exceptions", "-o", "/dev/null", "-c", "/source/vm.cpp"] };
  expect(compileArguments(entry, "/obj/Unified_vm.cpp", "/g2/Unified_vm.o"))
    .toEqual(["--sysroot", "/sysroot", "-fPIC", "-fno-exceptions", "-o", "/g2/Unified_vm.o", "-c", "/obj/Unified_vm.cpp", "-DBUNWASM_EMBED=1"]);
  expect(entry.arguments).toContain("/dev/null");
  expect(() => compileArguments({ ...entry, arguments: ["clang++", "-c", entry.file] }, entry.file, "/g2/vm.o")).toThrow(/incomplete/);
});
test("G2 rejects incomplete or non-string compiler inputs before executing", () => {
  for (const value of [null, {}, [null], [{ directory: "/obj", file: "vm.cpp", arguments: ["clang++", 7] }]]) {
    expect(() => parseCommands(value)).toThrow();
  }
  expect(parseCommands([{ directory: "/obj", file: "vm.cpp", arguments: ["clang++"] }])).toHaveLength(1);
});

type PatchState = "pristine" | "pre-applied";

function patchFixture(state: PatchState) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-smoke-patch-"));
  try {
    const repo = join(root, "repo");
    const build = join(root, "g1");
    const source = join(build, "firefox");
    const report = join(root, "report");
    const bin = join(root, "bin");
    for (const path of [join(repo, "spidermonkey"), source, join(build, "receipt"), report, bin]) mkdirSync(path, { recursive: true });
    writeFileSync(join(repo, "env.sh"), "");
    copyFileSync(resolve("spidermonkey/smoke.sh"), join(repo, "spidermonkey/smoke.sh"));
    const helper = resolve("spidermonkey/patch-lifecycle.sh");
    copyFileSync(helper, join(repo, "spidermonkey/patch-lifecycle.sh"));
    const patch = join(repo, "spidermonkey/spidermonkey-wasi.patch");
    writeFileSync(patch, "diff --git a/probe b/probe\n--- a/probe\n+++ b/probe\n@@ -1 +1 @@\n-pristine\n+patched\n");
    const init = spawnSync("git", ["init", "-q", source], { encoding: "utf8" });
    expect(init.status).toBe(0);
    writeFileSync(join(source, "probe"), state === "pristine" ? "pristine\n" : "patched\n");
    writeFileSync(join(build, "libspidermonkey_bunwasm.a"), "baseline archive");
    writeFileSync(join(build, "receipt/vm-library.json"), "baseline receipt");
    writeFileSync(join(bin, "node"), "#!/bin/sh\nprintf reached > \"$SPIDERMONKEY_G2_REPORT_DIR/node-called\"\nexit 7\n", { mode: 0o755 });
    writeFileSync(join(bin, "df"), `#!/bin/sh
if [ "$#" != 2 ] || [ "$1" != "-B1" ] || [ "$2" != "$SPIDERMONKEY_G2_DIR" ]; then
  printf 'storage probe must target the G2 output directory\\n' >&2
  exit 1
fi
printf 'fixture filesystem\\n'
`, { mode: 0o755 });
    return { root, repo, build, source, report, bin, patch };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

for (const state of ["pristine", "pre-applied"] as const) {
  test(`G2 smoke restores only its own patch after failure: ${state}`, () => {
    const fixture = patchFixture(state);
    try {
      const result = spawnSync("bash", [join(fixture.repo, "spidermonkey/smoke.sh")], {
        encoding: "utf8", timeout: 10_000,
        env: { ...process.env, PATH: fixture.bin + ":" + process.env.PATH,
          SPIDERMONKEY_BUILD_DIR: fixture.build, SPIDERMONKEY_G2_DIR: join(fixture.root, "g2"),
          SPIDERMONKEY_G2_REPORT_DIR: fixture.report },
      });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 7, stderr: "" });
      expect(readFileSync(join(fixture.report, "node-called"), "utf8")).toBe("reached");
      expect(readFileSync(join(fixture.source, "probe"), "utf8")).toBe(state === "pristine" ? "pristine\n" : "patched\n");
      expect(readFileSync(join(fixture.build, "libspidermonkey_bunwasm.a"), "utf8")).toBe("baseline archive");
      expect(readFileSync(join(fixture.build, "receipt/vm-library.json"), "utf8")).toBe("baseline receipt");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

const patchLifecycle = `source "$1"
state=$(spidermonkey_patch_prepare "$2" "$3")
trap 'spidermonkey_patch_restore "$state" "$2" "$3"' EXIT
printf '%s:%s' "$state" "$(cat "$2/probe")"`;

for (const state of ["pristine", "pre-applied"] as const) {
  test(`G2 patch lifecycle preserves the input state after success: ${state}`, () => {
    const fixture = patchFixture(state);
    try {
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", patchLifecycle,
        "patch-test", resolve("spidermonkey/patch-lifecycle.sh"), fixture.source, fixture.patch], { encoding: "utf8", timeout: 10_000 });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(result.stdout).toBe(state === "pristine" ? "applied:patched" : "present:patched");
      expect(readFileSync(join(fixture.source, "probe"), "utf8")).toBe(state === "pristine" ? "pristine\n" : "patched\n");
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test("G2 smoke rejects unrelated patch state before compilation without changing it", () => {
  const fixture = patchFixture("pristine");
  try {
    writeFileSync(join(fixture.source, "probe"), "unrelated edit\n");
    const result = spawnSync("bash", [join(fixture.repo, "spidermonkey/smoke.sh")], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: fixture.bin + ":" + process.env.PATH,
        SPIDERMONKEY_BUILD_DIR: fixture.build, SPIDERMONKEY_G2_DIR: join(fixture.root, "g2"),
        SPIDERMONKEY_G2_REPORT_DIR: fixture.report },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("patch neither applies nor is already applied");
    expect(existsSync(join(fixture.report, "node-called"))).toBe(false);
    expect(readFileSync(join(fixture.source, "probe"), "utf8")).toBe("unrelated edit\n");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
