import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(run: (f: { root: string; repository: string; vendor: string; base: string; first: string; final: string; git: (cwd: string, ...args: string[]) => string; sync: () => ReturnType<typeof Bun.spawnSync> }) => void) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-source-test-"));
  try {
    const repository = join(root, "upstream"), vendor = join(root, "vendor", "bun");
    mkdirSync(repository);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "patches", "bun"), { recursive: true });
    mkdirSync(join(root, "vendor"));
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", cwd].concat(args));
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    git(repository, "init", "-b", "patch-source");
    git(repository, "config", "user.name", "Source sync fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repository, "source.txt"), "base\n");
    git(repository, "add", "source.txt");
    git(repository, "commit", "-m", "fixture base");
    const base = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "source.txt"), "first patch\n");
    git(repository, "commit", "-am", "first fixture patch");
    const first = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "source.txt"), "second patch\n");
    git(repository, "commit", "-am", "second fixture patch");
    const final = git(repository, "rev-parse", "HEAD");
    git(repository, "branch", "wasm", final);
    git(repository, "format-patch", "--no-signature", "-o", join(root, "patches", "bun"), `${base}..HEAD`);
    git(repository, "worktree", "add", "--detach", vendor, first);
    // The fixture pins its tiny upstream rather than downloading Bun. All sync
    // logic, including linked-worktree handling and patch verification, is unchanged.
    const script = readFileSync(new URL("./sync-bun.sh", import.meta.url), "utf8").replace(/^BUN_COMMIT=.*$/m, `BUN_COMMIT=${base}`);
    writeFileSync(join(root, "scripts", "sync-bun.sh"), script);
    writeFileSync(join(root, "env.sh"), 'export TMPDIR="$BUN_WASM_TEST_TMP"\n');
    const sync = () => Bun.spawnSync(["bash", join(root, "scripts", "sync-bun.sh"), "--source-only"], {
      env: { ...process.env, BUN_WASM_TEST_TMP: root },
    });
    run({ root, repository, vendor, base, first, final, git, sync });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source sync advances an old detached worktree to the matching patched ref", () => {
  fixture(({ repository, vendor, final, git, sync }) => {
    const result = sync();
    expect(result.exitCode).toBe(0);
    expect(git(vendor, "rev-parse", "HEAD")).toBe(final);
    expect(readFileSync(join(vendor, "source.txt"), "utf8")).toBe("second patch\n");
    expect(sync().exitCode).toBe(0);
    expect(git(repository, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(2);
  });
});

test("source sync rebuilds a stale patched ref from checked-in patch bytes", () => {
  fixture(({ repository, vendor, base, git, sync }) => {
    git(repository, "branch", "-f", "wasm", base);
    const result = sync();
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(vendor, "source.txt"), "utf8")).toBe("second patch\n");
    expect(git(vendor, "rev-parse", "HEAD^{tree}")).toBe(git(repository, "rev-parse", "patch-source^{tree}"));
    expect(git(repository, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(2);
  });
});

for (const untracked of [false, true]) test(`source sync refuses ${untracked ? "untracked" : "tracked"} local changes`, () => {
  fixture(({ vendor, first, git, sync }) => {
    const path = join(vendor, untracked ? "owner.txt" : "source.txt");
    writeFileSync(path, "keep this work\n");
    const result = sync();
    expect(result.exitCode).toBe(1);
    expect((result.stderr ?? "").toString()).toContain("has local changes; refusing");
    expect(readFileSync(path, "utf8")).toBe("keep this work\n");
    expect(git(vendor, "rev-parse", "HEAD")).toBe(first);
  });
});
