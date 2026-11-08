import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, "-c", "user.name=Patch Author", "-c", "user.email=author@example.invalid"].concat(args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function unconfiguredEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
  return env;
}

test("source sync imports patches without a configured committer and preserves their author", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-source-identity-"));
  try {
    const origin = join(scratch, "origin"), root = join(scratch, "consumer"), home = join(scratch, "home");
    for (const directory of [origin, home, join(root, "scripts"), join(root, "patches/bun")]) mkdirSync(directory, { recursive: true });
    git(origin, ["init", "-q"]);
    git(origin, ["config", "uploadpack.allowFilter", "true"]);
    writeFileSync(join(origin, "source.txt"), "original\n");
    git(origin, ["add", "."]);
    git(origin, ["commit", "-qm", "upstream"]);
    const base = git(origin, ["rev-parse", "HEAD"]);
    writeFileSync(join(origin, "source.txt"), "patched\n");
    git(origin, ["commit", "-qam", "fixture patch"]);
    const tree = git(origin, ["rev-parse", "HEAD^{tree}"]);
    writeFileSync(join(root, "patches/bun/0001.patch"), git(origin, ["format-patch", "-1", "--stdout"]) + "\n");
    copyFileSync(new URL("../env.sh", import.meta.url), join(root, "env.sh"));
    const recipe = readFileSync(new URL("./sync-bun.sh", import.meta.url), "utf8")
      .replace(/^BUN_COMMIT=[0-9a-f]+$/m, `BUN_COMMIT=${base}`)
      .replace("https://github.com/oven-sh/bun.git", pathToFileURL(origin).href);
    const script = join(root, "scripts/sync-bun.sh");
    writeFileSync(script, recipe);
    const sync = () => {
      const result = spawnSync("bash", [script, "--source-only"], { encoding: "utf8", env: unconfiguredEnvironment(home), timeout: 3000 });
      expect(result.status, result.stderr).toBe(0);
      expect(git(join(root, "vendor/bun"), ["rev-parse", "HEAD^{tree}"])).toBe(tree);
      expect(git(join(root, "vendor/bun"), ["show", "-s", "--format=%an:%ae"])).toBe("Patch Author:author@example.invalid");
      expect(git(join(root, "vendor/bun"), ["show", "-s", "--format=%cn:%ce"])).toBe("bun-wasm source sync:source-sync@bun-wasm.invalid");
    };
    sync();
    git(join(root, "vendor/bun"), ["reset", "--hard", base]);
    sync();
    const checked = spawnSync("bash", [script, "--check"], { encoding: "utf8", env: unconfiguredEnvironment(home), timeout: 3000 });
    expect(checked.status, checked.stderr).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
