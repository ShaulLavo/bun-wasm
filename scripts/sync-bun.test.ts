import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

function fixture(run: (f: { root: string; repository: string; vendor: string; base: string; first: string; final: string; git: (cwd: string, ...args: string[]) => string; sync: (args?: string[], committerDate?: string) => ReturnType<typeof Bun.spawnSync> }) => void) {
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
    const script = readFileSync(new URL("./sync-bun.sh", import.meta.url), "utf8")
      .replace(/^BUN_COMMIT=.*$/m, `BUN_COMMIT=${base}`)
      .replace("https://github.com/oven-sh/bun.git", `file://${repository}`);
    writeFileSync(join(root, "scripts", "sync-bun.sh"), script);
    writeFileSync(join(root, "env.sh"), 'export TMPDIR="$BUN_WASM_TEST_TMP"\n');
    const sync = (args: string[] = [], committerDate = process.env.GIT_COMMITTER_DATE) => Bun.spawnSync(["bash", join(root, "scripts", "sync-bun.sh"), "--source-only"].concat(args), {
      env: { ...process.env, BUN_WASM_TEST_TMP: root, GIT_COMMITTER_DATE: committerDate },
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

test("reapplying the same patches produces the same commit for Bun codegen", () => {
  fixture(({ repository, vendor, base, git, sync }) => {
    git(repository, "branch", "-f", "wasm", base);
    expect(sync([], "2026-10-01T00:00:00Z").exitCode).toBe(0);
    const patched = git(vendor, "rev-parse", "HEAD");
    git(vendor, "checkout", "--detach", base);
    expect(sync([], "2026-11-01T00:00:00Z").exitCode).toBe(0);
    expect(git(vendor, "rev-parse", "HEAD")).toBe(patched);
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

// Builds check the checked-in patch bytes without silently advancing source.
test("source check rejects stale source without changing HEAD, then accepts synchronized source", () => {
  fixture(({ repository, vendor, first, final, git, sync }) => {
    const stale = sync(["--check"]);
    expect(stale.exitCode).toBe(1);
    expect((stale.stderr ?? "").toString()).toContain("differs from the checked-in patch series");
    expect(git(vendor, "rev-parse", "HEAD")).toBe(first);
    expect(sync().exitCode).toBe(0);
    expect(sync(["--check"]).exitCode).toBe(0);
    expect(git(vendor, "rev-parse", "HEAD")).toBe(final);
    expect(git(repository, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(2);
  });
});

test("source check never creates a missing checkout", () => {
  fixture(({ repository, vendor, git, sync }) => {
    git(repository, "worktree", "remove", vendor);
    const result = sync(["--check"]);
    expect(result.exitCode).toBe(1);
    expect((result.stderr ?? "").toString()).toContain("missing vendor/bun checkout");
  });
});

test("cold source sync fetches only the pinned revision and verifies every patch", () => {
  fixture(({ repository, vendor, base, git, sync }) => {
    git(repository, "worktree", "remove", vendor);
    git(repository, "config", "uploadpack.allowFilter", "true");
    const tree = git(repository, "rev-parse", "HEAD^{tree}");
    writeFileSync(join(repository, "default-only.txt"), "not part of the pinned source\n");
    git(repository, "add", "default-only.txt");
    git(repository, "commit", "-m", "unrelated upstream default branch");
    git(repository, "tag", "default-only");
    const result = sync();
    expect(result.exitCode).toBe(0);
    expect(git(vendor, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(readFileSync(join(vendor, ".git", "shallow"), "utf8").trim()).toBe(base);
    expect(git(vendor, "rev-list", "--count", "HEAD")).toBe("3");
    expect(git(vendor, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(() => readFileSync(join(vendor, "default-only.txt"))).toThrow();
    expect(git(vendor, "branch", "--show-current")).toBe("wasm");
    expect(git(vendor, "tag", "--list")).toBe("");
    expect(sync(["--check"]).exitCode).toBe(0);
    expect(sync().exitCode).toBe(0);
  });
});

test("cold source sync refuses a broken checked-in patch", () => {
  fixture(({ root, repository, vendor, git, sync }) => {
    git(repository, "worktree", "remove", vendor);
    git(repository, "config", "uploadpack.allowFilter", "true");
    writeFileSync(join(root, "patches/bun/0000-broken.patch"), "invalid patch\n");
    expect(sync().exitCode).not.toBe(0);
    expect(git(vendor, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(sync(["--check"]).exitCode).not.toBe(0);
  });
});

// A full sync (source, vendored dependencies, codegen) against a tiny stand-in for Bun's
// repository: two pins, each with its own dependency pins and our one patch on top.
function upgradeFixture(run: (f: { vendor: string; oldTip: string; newTip: string; git: (cwd: string, ...args: string[]) => string; pin: (which: "old" | "new") => void; sync: (args?: string[]) => { exitCode: number; stderr: string } }) => void) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-source-upgrade-"));
  try {
    const repository = join(root, "upstream"), vendor = join(root, "vendor", "bun");
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", cwd].concat(args));
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const write = (path: string, text: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    // Dependency archives, as GitHub serves them: one top-level directory.
    const archive = (repo: string, commit: string, lines: string) => {
      const source = join(root, "unpacked", commit, "package");
      write(join(source, "Cargo.toml"), `# ${commit}\n`);
      write(join(source, "lib.txt"), lines);
      mkdirSync(join(root, "archives", repo), { recursive: true });
      expect(Bun.spawnSync(["tar", "czf", join(root, "archives", repo, `${commit}.tar.gz`), "-C", join(source, ".."), "package"]).exitCode).toBe(0);
    };
    const lolhtml = { old: "1".repeat(40), new: "2".repeat(40) }, argon2 = "3".repeat(40);
    archive("oven-sh/lol-html", lolhtml.old, "old html\n");
    archive("oven-sh/lol-html", lolhtml.new, "new html\n");
    archive("sru-systems/rust-argon2", argon2, "one\ntwo\nthree\n");
    const upstream = (version: string, html: string, patches: string[]) => {
      write(join(repository, "package.json"), `${JSON.stringify({ name: "upstream", version })}\n`);
      write(join(repository, "scripts/build/deps/lolhtml.ts"), `const LOLHTML_COMMIT = "${html}";\n`);
      write(join(repository, "scripts/build/deps/rust-argon2.ts"), `const RUST_ARGON2_COMMIT = "${argon2}";\nexport const patches = ${JSON.stringify(patches)};\n`);
      git(repository, "add", "-A");
      git(repository, "commit", "-m", `upstream ${version}`);
      return git(repository, "rev-parse", "HEAD");
    };
    // Our port: one commit on top of a pin, exported the way scripts/export-patches.sh does.
    const port = (base: string, name: string) => {
      git(repository, "checkout", "-q", "-b", `port-${name}`, base);
      writeFileSync(join(repository, "source.txt"), "ported\n");
      git(repository, "commit", "-am", "port to wasm");
      git(repository, "format-patch", "--no-signature", "-o", join(root, "series", name), `${base}..HEAD`);
      const tip = git(repository, "rev-parse", "HEAD^{tree}");
      git(repository, "checkout", "-q", "main");
      return tip;
    };
    mkdirSync(repository);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Source sync fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    git(repository, "config", "uploadpack.allowFilter", "true");
    git(repository, "config", "uploadpack.allowAnySHA1InWant", "true");
    write(join(repository, ".gitignore"), "/build\n/vendor\nnode_modules\nbun.lock\n");
    write(join(repository, "source.txt"), "native\n");
    // Stands in for Bun's configure: like Bun, it pins the commit of a local build at first use.
    write(join(repository, "scripts/build.ts"), `import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const pinned = "build/debug/git-revision";
const sha = existsSync(pinned) ? readFileSync(pinned, "utf8").trim() : execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
mkdirSync("build/debug/codegen", { recursive: true });
writeFileSync(pinned, sha + "\\n");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync("build/debug/codegen/build_options.rs", \`pub const SHA: &str = "\${sha}";\\npub const VERSION: &str = "\${version}";\\n\`);
for (const name of ["json_byte_class.rs", "xml_byte_class.rs"]) writeFileSync("build/debug/codegen/" + name, "");
`);
    write(join(repository, "patches/rust-argon2/first.patch"), "--- a/lib.txt\n+++ b/lib.txt\n@@ -1,3 +1,3 @@\n-one\n+one patched\n two\n three\n");
    const pins = { old: upstream("1.0.0", lolhtml.old, ["patches/rust-argon2/first.patch"]), new: "" };
    write(join(repository, "patches/rust-argon2/second.patch"), "--- a/lib.txt\n+++ b/lib.txt\n@@ -1,3 +1,3 @@\n one patched\n-two\n+two patched\n three\n");
    pins.new = upstream("1.0.1", lolhtml.new, ["patches/rust-argon2/first.patch", "patches/rust-argon2/second.patch"]);
    const oldTip = port(pins.old, "old"), newTip = port(pins.new, "new");
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "env.sh"), 'export TMPDIR="$BUN_WASM_TEST_TMP"\n');
    const pin = (which: "old" | "new") => {
      rmSync(join(root, "patches", "bun"), { recursive: true, force: true });
      mkdirSync(join(root, "patches", "bun"), { recursive: true });
      for (const name of readdirSync(join(root, "series", which))) copyFileSync(join(root, "series", which, name), join(root, "patches", "bun", name));
      const script = readFileSync(new URL("./sync-bun.sh", import.meta.url), "utf8")
        .replace(/^BUN_COMMIT=.*$/m, `BUN_COMMIT=${pins[which]}`)
        .replace("https://github.com/oven-sh/bun.git", `file://${repository}`)
        .replace("https://github.com/$repo/archive/", `file://${root}/archives/$repo/`);
      writeFileSync(join(root, "scripts", "sync-bun.sh"), script);
    };
    const sync = (args: string[] = []) => {
      const result = Bun.spawnSync(["bash", join(root, "scripts", "sync-bun.sh")].concat(args), { env: { ...process.env, BUN_WASM_TEST_TMP: root }, stdout: "pipe", stderr: "pipe" });
      return { exitCode: result.exitCode, stderr: result.stderr.toString() };
    };
    run({ vendor, oldTip, newTip, git, pin, sync });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a checkout at the old pin syncs to a new pin with fresh codegen and dependency patches", () => {
  upgradeFixture(({ vendor, oldTip, newTip, git, pin, sync }) => {
    const read = (path: string) => readFileSync(join(vendor, path), "utf8");
    pin("old");
    const first = sync();
    expect(first.exitCode, first.stderr).toBe(0);
    expect(git(vendor, "rev-parse", "HEAD^{tree}")).toBe(oldTip);
    expect(read("build/debug/codegen/build_options.rs")).toBe(`pub const SHA: &str = "${git(vendor, "rev-parse", "HEAD")}";\npub const VERSION: &str = "1.0.0";\n`);
    expect(read("vendor/lolhtml/lib.txt")).toBe("old html\n");
    expect(read("vendor/rust-argon2/lib.txt")).toBe("one patched\ntwo\nthree\n");

    pin("new");
    const stale = sync(["--check"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("does not have the pinned commit");
    expect(git(vendor, "rev-parse", "HEAD^{tree}")).toBe(oldTip);

    const upgraded = sync();
    expect(upgraded.exitCode, upgraded.stderr).toBe(0);
    expect(git(vendor, "rev-parse", "HEAD^{tree}")).toBe(newTip);
    expect(read("source.txt")).toBe("ported\n");
    expect(read("build/debug/codegen/build_options.rs")).toBe(`pub const SHA: &str = "${git(vendor, "rev-parse", "HEAD")}";\npub const VERSION: &str = "1.0.1";\n`);
    expect(read("vendor/lolhtml/lib.txt")).toBe("new html\n");
    expect(read("vendor/rust-argon2/lib.txt")).toBe("one patched\ntwo patched\nthree\n");
    expect(sync(["--check"]).exitCode).toBe(0);

    // Nothing changed, so a second sync leaves the dependencies and generated files alone.
    const unpacked = ["vendor/lolhtml", "vendor/rust-argon2"].map(path => statSync(join(vendor, path)).ino);
    writeFileSync(join(vendor, "build/debug/codegen/kept"), "");
    expect(sync().exitCode).toBe(0);
    expect(["vendor/lolhtml", "vendor/rust-argon2"].map(path => statSync(join(vendor, path)).ino)).toEqual(unpacked);
    expect(read("build/debug/codegen/kept")).toBe("");
    expect(readdirSync(join(vendor, "vendor")).toSorted()).toEqual([".bun-wasm-lolhtml.source", ".bun-wasm-rust-argon2.source", "lolhtml", "rust-argon2"]);
  });
});

// Bun's .gitignore hides vendor/, so the script itself has to notice work in the dependency trees.
for (const markers of [true, false]) test(`local work in a dependency tree ${markers ? "with" : "without"} its marker is never replaced`, () => {
  upgradeFixture(({ vendor, git, pin, sync }) => {
    const read = (path: string) => readFileSync(join(vendor, path), "utf8");
    pin("old");
    expect(sync().exitCode).toBe(0);
    if (!markers) for (const name of ["lolhtml", "rust-argon2"]) rmSync(join(vendor, "vendor", `.bun-wasm-${name}.source`));
    writeFileSync(join(vendor, "vendor/rust-argon2/Cargo.toml"), "# my edit\n");
    writeFileSync(join(vendor, "vendor/lolhtml/mine.txt"), "my file\n");
    expect(git(vendor, "status", "--porcelain", "--untracked-files=normal")).toBe("");

    // The same pin first: nothing needs replacing, and the work must still survive.
    for (const which of ["old", "new"] as const) {
      pin(which);
      const refused = sync();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("refusing to replace it");
      expect(refused.stderr).toContain(`rm -rf ${join(vendor, "vendor/lolhtml")}`);
      expect(read("vendor/rust-argon2/Cargo.toml")).toBe("# my edit\n");
      expect(read("vendor/lolhtml/mine.txt")).toBe("my file\n");
      expect(readdirSync(join(vendor, "vendor")).filter(name => !name.endsWith(".source")).toSorted()).toEqual(["lolhtml", "rust-argon2"]);
    }

    // Removing the trees, as the message says, lets the sync finish.
    for (const name of ["lolhtml", "rust-argon2"]) rmSync(join(vendor, "vendor", name), { recursive: true });
    const synced = sync();
    expect(synced.exitCode, synced.stderr).toBe(0);
    expect(read("vendor/lolhtml/lib.txt")).toBe("new html\n");
    expect(read("vendor/rust-argon2/lib.txt")).toBe("one patched\ntwo patched\nthree\n");
  });
});

test("an untouched dependency tree from before the markers moves to the new patches", () => {
  upgradeFixture(({ vendor, pin, sync }) => {
    pin("old");
    expect(sync().exitCode).toBe(0);
    // The commit is the same at both pins, so the old tree is the pinned archive with its first patch.
    rmSync(join(vendor, "vendor/.bun-wasm-rust-argon2.source"));
    pin("new");
    const synced = sync();
    expect(synced.exitCode, synced.stderr).toBe(0);
    expect(readFileSync(join(vendor, "vendor/rust-argon2/lib.txt"), "utf8")).toBe("one patched\ntwo patched\nthree\n");
    expect(readFileSync(join(vendor, "vendor/.bun-wasm-rust-argon2.source"), "utf8")).toContain("\ntree ");
  });
});
