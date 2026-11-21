import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const interruptionExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function runProtectedGit(...args: string[]): string {
  const command = ["-p", "-c", 'trap "" HUP INT TERM; exec git "$@"', "git"].concat(args);
  const run = () => execFileSync("bash", command, { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  try {
    return run();
  } catch (error) {
    // A signal can reach the shell before it installs the ignore handlers.
    if (!(error instanceof Error) || !("signal" in error) || typeof error.signal !== "string"
      || !Object.hasOwn(interruptionExitCodes, error.signal)) throw error;
    return run();
  }
}

function registeredCheckout(checkout: string): boolean {
  const entries = runProtectedGit("worktree", "list", "--porcelain", "-z");
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
      runProtectedGit("worktree", "remove", "--force", checkout);
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
for (const [signal, code] of Object.entries(interruptionExitCodes)) {
  process.on(signal, () => { interrupted ??= code; });
}
const status = await main(Bun.argv.slice(2));
process.exitCode = interrupted ?? status;
