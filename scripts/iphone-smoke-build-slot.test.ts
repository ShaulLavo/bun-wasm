import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "iphone-smoke-build-slot.ts");

async function fixture(run: (input: { repository: string; checkout: string; revision: string }) => Promise<void> | void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bun-wasm-iphone-build-test-")));
  try {
    const repository = join(root, "repo");
    mkdirSync(repository);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
    git("init", "--quiet");
    git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Fixture");
    const checkout = join(root, "checkout");
    await run({ repository, checkout, revision: git("rev-parse", "HEAD").trim() });
    expect(git("worktree", "list", "--porcelain")).not.toContain(`worktree ${checkout}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function invocation(checkout: string, revision: string, script: string): string[] {
  return [process.execPath, cli, checkout, revision, "--", "bash", "-eu", "-c", script];
}

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
      expect(result.stdout.toString()).toBe(expected);
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
      const reader = owner.stdout.getReader();
      try { expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n"); }
      finally { reader.releaseLock(); }
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
    const ready = 'printf "ready\\n"; read -r || true';
    const hook = join(repository, ".git", "hooks", "post-checkout");
    if (phase === "checkout") writeFileSync(hook, `#!/bin/sh\n${ready}\n`, { mode: 0o755 });
    const command = invocation(checkout, revision, phase === "build" ? ready : "exit 93");
    const owner = Bun.spawn(["bash", "-c", 'exec "$@" 2>&1', "bash"].concat(command), {
      cwd: repository, detached: true, stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 60_000,
    });
    const reader = owner.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      process.kill(-owner.pid, signal);
      expect(await owner.exited).toBe(status);
      expect(existsSync(checkout)).toBe(false);
    } finally {
      reader.releaseLock();
      owner.stdin.end();
      await owner.exited;
    }
    rmSync(hook, { force: true });
    const next = Bun.spawnSync(invocation(checkout, revision, "true"), { cwd: repository });
    expect(next.exitCode, next.stderr.toString()).toBe(0);
  });
}, 65_000);
