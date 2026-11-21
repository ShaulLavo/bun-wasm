import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

function registeredCheckout(checkout: string): boolean {
  const entries = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { encoding: "utf8" });
  return entries.split("\0").includes(`worktree ${checkout}`);
}

async function build(checkout: string, revision: string, command: string[]): Promise<number> {
  if (lstatSync(checkout, { throwIfNoEntry: false }) || registeredCheckout(checkout)) {
    throw new Error(`Smoke build checkout already exists: ${checkout}`);
  }
  try {
    const added = await Bun.spawn(["git", "worktree", "add", "--quiet", "--detach", checkout, revision], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    }).exited;
    if (interrupted !== undefined) return interrupted;
    if (added !== 0) return added;

    const work = join(checkout, "target", "iphone-smoke");
    const tmp = join(work, "tmp");
    mkdirSync(tmp, { recursive: true });
    const child = Bun.spawn(command, {
      cwd: checkout,
      env: {
        ...process.env,
        IPHONE_SMOKE_BUILD_DIR: work,
        CARGO_TARGET_DIR: join(work, "cargo"),
        BROWSER_CARGO_TARGET_DIR: join(work, "browser"),
        TOOLS_CARGO_TARGET_DIR: join(work, "tools"),
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  } finally {
    if (registeredCheckout(checkout)) {
      execFileSync("git", ["worktree", "remove", "--force", checkout], { stdio: "inherit" });
    }
  }
}

async function main(args: string[]): Promise<number> {
  const underLock = args[0] === "--under-lock";
  const [path, revision, separator, ...command] = underLock ? args.slice(1) : args;
  if (!path || !isAbsolute(path) || !revision || !/^[0-9a-f]{40}$/.test(revision) || separator !== "--" || !command[0]) {
    throw new Error("Usage: bun scripts/iphone-smoke-build-slot.ts /absolute/checkout <full-commit> -- <build-command...>");
  }
  const requested = resolve(path);
  const checkout = join(realpathSync(dirname(requested)), basename(requested));
  if (underLock) return build(checkout, revision, command);

  const lock = `${checkout}.lock`;
  return Bun.spawn(["flock", "--no-fork", "--nonblock", "--conflict-exit-code", "75", lock, process.execPath, import.meta.path, "--under-lock"]
    .concat([checkout, revision, "--"], command), { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}

// The heavy runner signals the full build scope. Keep the lock and wait for
// the build command to finish its own teardown before removing the checkout.
let interrupted: number | undefined;
for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => { interrupted ??= code; });
}
const status = await main(Bun.argv.slice(2));
process.exitCode = interrupted ?? status;
