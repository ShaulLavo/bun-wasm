import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "iphone-smoke-build-slot.ts");

function fixtureProject(directory: string, linker: "isolated" | "hoisted"): void {
  const dependency = join(directory, "dependency");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "fixture-project", private: true, dependencies: { "slot-fixture": "file:./dependency" },
  }));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "slot-fixture", version: "1.0.0" }));
  writeFileSync(join(directory, "bunfig.toml"), `[install]\nlinker = "${linker}"\n`);
  execFileSync(process.execPath, ["install", "--lockfile-only", "--ignore-scripts", "--silent"], { cwd: directory });
}

async function fixture(run: (input: { repository: string; checkout: string; revision: string; git: (...args: string[]) => string }) => Promise<void> | void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bun-wasm-iphone-build-test-")));
  try {
    const repository = join(root, "repo");
    mkdirSync(repository);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
    git("init", "--quiet");
    fixtureProject(repository, "isolated");
    fixtureProject(join(repository, "web"), "hoisted");
    git("add", ".");
    git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--quiet", "-m", "Fixture");
    const checkout = join(root, "checkout");
    await run({ repository, checkout, revision: git("rev-parse", "HEAD").trim(), git });
    expect(git("worktree", "list", "--porcelain")).not.toContain(`worktree ${checkout}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function invocation(checkout: string, revision: string, script: string): string[] {
  return [process.execPath, cli, checkout, revision, "--", "bash", "-eu", "-c", script];
}

test("the exact build checkout supplies the linker for each frozen install", async () => {
  await fixture(({ repository, checkout, revision }) => {
    writeFileSync(join(repository, "bunfig.toml"), '[install]\nlinker = "hoisted"\n');
    writeFileSync(join(repository, "web", "bunfig.toml"), '[install]\nlinker = "isolated"\n');
    const result = Bun.spawnSync(invocation(checkout, revision, `
      test -L node_modules/slot-fixture
      test -f web/node_modules/slot-fixture/package.json
      test ! -L web/node_modules/slot-fixture
      git diff --exit-code
    `), { cwd: repository });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(checkout)).toBe(false);
  });
});

test("a missing Web lockfile skips preparation and releases the slot", async () => {
  await fixture(({ repository, checkout, revision, git }) => {
    git("rm", "web/bun.lock");
    git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--quiet", "-m", "Missing web lock");
    const broken = git("rev-parse", "HEAD").trim();
    const failed = Bun.spawnSync(invocation(checkout, broken, "exit 93"), { cwd: repository });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain(`requires package.json and bun.lock in ${join(checkout, "web")}`);
    expect(existsSync(checkout)).toBe(false);
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
});

test("a stale Web lockfile reports Bun's frozen install error", async () => {
  await fixture(({ repository, checkout, revision, git }) => {
    const manifest = join(repository, "web", "package.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace("./dependency", "./dependency-v2"));
    const alternative = join(repository, "web", "dependency-v2");
    mkdirSync(alternative);
    writeFileSync(join(alternative, "package.json"), JSON.stringify({ name: "slot-fixture", version: "2.0.0" }));
    git("add", "web");
    git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--quiet", "-m", "Stale web lock");
    const broken = git("rev-parse", "HEAD").trim();
    const failed = Bun.spawnSync(invocation(checkout, broken, "exit 93"), { cwd: repository });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain("lockfile is frozen");
    expect(existsSync(checkout)).toBe(false);
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
});

function stopFixtureGroup(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function waitForFile(path: string, stopped = () => false): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!existsSync(path) && !stopped() && performance.now() < deadline) await Bun.sleep(20);
  expect(existsSync(path), path).toBe(true);
}

async function waitForLine(stream: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (!output.split("\n").includes(expected)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Missing "${expected}" in output: ${output}`);
      output += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

test("termination during a Bun install holds the slot through lifecycle cleanup", async () => {
  await fixture(async ({ repository, checkout, revision, git }) => {
    const root = join(repository, "..");
    const manifest = join(repository, "package.json");
    const dependencies = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...dependencies, scripts: { prepare: "bun install-lifecycle.ts" } }));
    writeFileSync(join(repository, "install-lifecycle.ts"), `
const child = Bun.spawn([process.execPath, "install-child.ts"], {
  detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
});
process.exitCode = await child.exited;
`);
    writeFileSync(join(repository, "install-child.ts"), `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.SLOT_TEST_ROOT;
if (!root) throw new Error("Missing fixture root");
process.on("SIGTERM", () => writeFileSync(join(root, "stopping"), ""));
writeFileSync(join(root, "ready"), String(process.pid));
while (!existsSync(join(root, "release"))) await Bun.sleep(20);
writeFileSync(join(root, "finished"), "");
`);
    git("add", "package.json", "install-lifecycle.ts", "install-child.ts");
    git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--quiet", "-m", "Install lifecycle");
    const blocking = git("rev-parse", "HEAD").trim();
    const owner = Bun.spawn(invocation(checkout, blocking, "exit 93"), {
      cwd: repository, env: { ...process.env, SLOT_TEST_ROOT: root },
      detached: true, stdout: "ignore", stderr: "ignore", timeout: 35_000,
    });
    const finished = join(root, "finished");
    let signaled = false;
    try {
      await waitForFile(join(root, "ready"));
      process.kill(-owner.pid, "SIGTERM");
      signaled = true;
      await waitForFile(join(root, "stopping"), () => owner.exitCode !== null);
      const contender = Bun.spawnSync(invocation(checkout, revision, "exit 23"), { cwd: repository });
      expect(contender.exitCode).toBe(75);
      expect(existsSync(checkout)).toBe(true);
    } finally {
      writeFileSync(join(root, "release"), "");
      if (!signaled) stopFixtureGroup(owner.pid);
      await owner.exited;
      if (existsSync(join(root, "ready"))) await waitForFile(finished);
    }
    expect(owner.exitCode).toBe(143);
    const descendant = readFileSync(join(root, "ready"), "utf8");
    expect(existsSync(`/proc/${descendant}`)).toBe(false);
    expect(existsSync(checkout)).toBe(false);
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
}, 65_000);

test("each build uses the same paths and starts from a clean exact checkout", async () => {
  await fixture(({ repository, checkout, revision }) => {
    const command = invocation(checkout, revision, `
      test ! -e "$CARGO_TARGET_DIR"
      mkdir -p "$CARGO_TARGET_DIR"
      printf '%s\n' "$(git rev-parse HEAD)" "$PWD" "$CARGO_TARGET_DIR" "$BROWSER_CARGO_TARGET_DIR" "$TOOLS_CARGO_TARGET_DIR" "$TMPDIR"
    `);
    const work = join(checkout, "target", "iphone-smoke");
    const expected = [revision, checkout].concat(["cargo", "browser", "tools", "tmp"].map(name => join(work, name)), [""]).join("\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = Bun.spawnSync(command, { cwd: repository });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toEndWith(expected);
      expect(existsSync(checkout)).toBe(false);
    }
  });
});

test("an overlapping build cannot take the slot and failure releases it", async () => {
  await fixture(async ({ repository, checkout, revision }) => {
    const owner = Bun.spawn(invocation(checkout, revision, 'printf "ready\\n"; read -r || true; exit 24'), {
      cwd: repository, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    try {
      await waitForLine(owner.stdout, "ready");
      const contender = Bun.spawnSync(invocation(checkout, revision, "exit 23"), { cwd: repository });
      expect(contender.exitCode).toBe(75);
      expect(existsSync(checkout)).toBe(true);
    } finally {
      owner.stdin.end();
      await owner.exited;
    }
    expect(owner.exitCode).toBe(24);
    expect(existsSync(checkout)).toBe(false);
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
});

test("a pre-existing checkout symlink and its target are preserved", async () => {
  await fixture(({ repository, checkout, revision }) => {
    symlinkSync(repository, checkout);
    const result = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Smoke build checkout already exists");
    expect(realpathSync(checkout)).toBe(repository);
  });
});

test("a pre-existing Git registration is preserved even if its checkout is absent", async () => {
  await fixture(({ repository, checkout, revision }) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
    git("worktree", "add", "--quiet", "--detach", checkout, revision);
    rmSync(checkout, { recursive: true });
    try {
      const result = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("Smoke build checkout already exists");
      expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${checkout}\n`);
    } finally {
      git("worktree", "remove", "--force", checkout);
    }
  });
});

test("a failed checkout hook leaves the slot available for the next build", async () => {
  await fixture(({ repository, checkout, revision }) => {
    const hook = join(repository, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\nexit 24\n", { mode: 0o755 });
    const failed = Bun.spawnSync(invocation(checkout, revision, "exit 93"), { cwd: repository });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.exitCode).not.toBe(93);
    expect(existsSync(checkout)).toBe(false);
    rmSync(hook);
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
});

test.each([
  { phase: "checkout", signal: "SIGTERM", status: 143 },
  { phase: "build", signal: "SIGHUP", status: 129 },
] as const)("$signal during $phase releases the slot", async ({ phase, signal, status }) => {
  await fixture(async ({ repository, checkout, revision }) => {
    const ready = 'printf "ready\\n"; read -r release || true';
    const hook = join(repository, ".git", "hooks", "post-checkout");
    // Git gives checkout hooks an empty stdin. Stay in checkout until the group is signaled.
    if (phase === "checkout") writeFileSync(hook, '#!/bin/sh\nprintf "ready\\n"\nexec sleep 60\n', { mode: 0o755 });
    const command = invocation(checkout, revision, phase === "build" ? ready : "exit 93");
    const owner = Bun.spawn(["bash", "-c", 'exec "$@" 2>&1', "bash"].concat(command), {
      cwd: repository, detached: true, stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 60_000,
    });
    let signaled = false;
    try {
      await waitForLine(owner.stdout, "ready");
      process.kill(-owner.pid, signal);
      signaled = true;
      expect(await owner.exited).toBe(status);
      expect(existsSync(checkout)).toBe(false);
    } finally {
      if (!signaled) stopFixtureGroup(owner.pid);
      owner.stdin.end();
      await owner.exited;
    }
    rmSync(hook, { force: true });
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
}, 65_000);

test("termination during Git cleanup leaves the slot available", async () => {
  await fixture(async ({ repository, checkout, revision }) => {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("Git is required for the build slot test");
    const bin = join(repository, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ]; then
  printf 'cleanup ready\\n' >&2
  read -r release || true
fi
exec "$SLOT_TEST_GIT" "$@"
`, { mode: 0o755 });
    const command = invocation(checkout, revision, "true");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_TEST_GIT: realGit };
    const owner = Bun.spawn(command, {
      cwd: repository, env, detached: true, stdin: "pipe", stdout: "inherit", stderr: "pipe", timeout: 60_000,
    });
    try {
      await waitForLine(owner.stderr, "cleanup ready");
      process.kill(-owner.pid, "SIGTERM");
    } finally {
      owner.stdin.end();
      await owner.exited;
    }
    expect(await owner.exited).toBe(143);
    expect(existsSync(checkout)).toBe(false);
    const next = Bun.spawnSync(command, { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
}, 65_000);
