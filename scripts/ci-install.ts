import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageReleasePackages, verifyStagedResolutions } from "./ci-stage-release-packages";
import { releaseDownload } from "./ci-release-download";

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

export function runBunInstall(directory: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["install"].concat(args), { cwd: directory, stdio: "inherit", detached: true });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      signalGroup(child.pid, "SIGTERM");
      escalation ??= setTimeout(() => signalGroup(child.pid, "SIGKILL"), 1000);
    };
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", reject);
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      clearTimeout(escalation);
      signalGroup(child.pid, "SIGKILL");
      if (code === 0 && !signal.aborted) resolve();
      else reject(new Error(`Bun install failed: ${code}`));
    });
  });
}

export async function installStagedPackages(directory: string, args: readonly string[], download = releaseDownload): Promise<void> {
  const manifest = await readFile(join(directory, "package.json"));
  const lock = await readFile(join(directory, "bun.lock"));
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-ci-install-"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop);

  try {
    const locations = await stageReleasePackages(directory, directory, (url, options) => download(url, { ...options, signal: AbortSignal.any([controller.signal, options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 180_000)]) }), join(scratch, "archives"));
    verifyStagedResolutions(lock.toString(), await readFile(join(directory, "bun.lock"), "utf8"), locations);
    await runBunInstall(directory, args, controller.signal);
  } finally {
    await writeFile(join(directory, "package.json"), manifest);
    await writeFile(join(directory, "bun.lock"), lock);
    await rm(scratch, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, stop);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--cwd");
  const directory = index < 0 ? process.cwd() : resolve(args[index + 1]!);
  if (index >= 0) args.splice(index, 2);
  await installStagedPackages(directory, args);
}
