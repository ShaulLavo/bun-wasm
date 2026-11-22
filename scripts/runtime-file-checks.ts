import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, discoverChecks, selectChecks } from "./test-checks.ts";

export function runtimeJobs(value: string): 1 | 2 {
  if (value === "1") return 1;
  if (value === "2") return 2;
  throw new Error(`Invalid BUN_WASM_RUNTIME_JOBS: ${value}; expected 1 or 2`);
}

export function runtimePlan(paths: readonly string[], checks = discoverChecks()) {
  const runtime = new Map(checks.filter(check => check.owner === "runtime").map(check => [check.path, check]));
  if (new Set(paths).size !== paths.length || paths.some(path => !runtime.has(path))) throw new Error("Invalid runtime file selection");
  const isolated = paths.filter(path => runtime.get(path)?.isolation === "process");
  const independent = new Set(isolated);
  return { serial: paths.filter(path => !independent.has(path)), isolated };
}

function execute(command: readonly string[], env = process.env): Promise<number> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing runtime command");
  return new Promise(resolve => {
    const child = spawn(executable, args, { env, stdio: "inherit" });
    child.once("error", (error: NodeJS.ErrnoException) => { console.error(error.message); resolve(error.code === "ENOENT" ? 127 : 126); });
    child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
}

// No process control here: the existing supervisor owns this worker and every descendant.
export async function dispatchRuntime(plan: ReturnType<typeof runtimePlan>, run = (paths: readonly string[]) => execute(checkCommand("runtime", paths))): Promise<number> {
  const serial = plan.serial.length ? [plan.serial] : [];
  const batches = serial.concat(plan.isolated.map(path => [path]));
  let next = 0;
  let failure = 0;
  async function worker(): Promise<void> {
    while (failure === 0) {
      const paths = batches[next++];
      if (paths === undefined) return;
      const status = await run(paths);
      failure ||= status;
    }
  }
  await Promise.all([worker(), worker()]);
  return failure;
}

function removeScratch(scratch: string, state: string, pid: number | undefined): void {
  if (pid !== undefined && !existsSync(join(state, "status"))) throw new Error(`Runtime supervisor did not confirm drain; preserving scratch at ${scratch}`);
  rmSync(scratch, { recursive: true, force: true });
}

export async function runRuntimeChecks(paths: readonly string[], env = process.env): Promise<number> {
  // Validate before creating scratch or starting the supervisor. New files default to serial.
  runtimePlan(paths);
  if (process.platform !== "linux") throw new Error("Bounded runtime checks require the Linux process supervisor");
  const scratch = mkdtempSync(join(env.TMPDIR ?? tmpdir(), "bun-wasm-runtime-files-"));
  const state = join(scratch, "supervisor");
  mkdirSync(state);
  const supervisor = join(import.meta.dir, "run-with-timeout.mts");
  const command = [supervisor, "--state", state, "--until-exit", process.execPath, import.meta.filename, "--worker"].concat(paths);
  const child = spawn(process.execPath, command, {
    env: { ...env, TMPDIR: scratch, WASM_TABLE_TMP: scratch, RAYON_NUM_THREADS: "2" },
    stdio: "inherit",
  });
  let interrupted = 0;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const handler = () => {
      interrupted ||= 128 + constants.signals[signal];
      writeFileSync(join(state, "stop"), "stop\n");
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
    return interrupted || status;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
    removeScratch(scratch, state, child.pid);
  }
}

if (import.meta.main) {
  const [mode, ...paths] = process.argv.slice(2);
  if (mode === "--worker") process.exitCode = await dispatchRuntime(runtimePlan(paths));
  else if (mode === undefined) process.exitCode = await runRuntimeChecks(selectChecks("runtime"));
  else throw new Error("Usage: runtime-file-checks.ts [--worker <runtime paths...>]");
}
