import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, discoverChecks, selectChecks } from "./test-checks.ts";

export type RuntimeJobs = 1 | 2 | 3 | 4;

// Start the slowest manifest-isolated files first so long tails overlap the serial batch.
const isolatedDispatchPriority = [
  "scripts/spidermonkey-panic-process.test.ts",
  "scripts/wasm-tables.test.ts",
  "scripts/runtime-assert-util.test.ts",
  "scripts/rust-native-cache.test.ts",
  "scripts/hot-run-live.test.ts",
  "scripts/spidermonkey-module-evaluation-info.test.ts",
  "scripts/package-port-typed.test.ts",
  "scripts/install-tarballs.test.ts",
  "scripts/install-metadata.test.ts",
  "scripts/legacy-cli-runtime.test.ts",
  "scripts/wasm-validation.test.ts",
  "scripts/install-selection.test.ts",
];

export function runtimeJobs(value: string): RuntimeJobs {
  if (value === "1" || value === "2" || value === "3" || value === "4") return Number(value) as RuntimeJobs;
  throw new Error(`Invalid BUN_WASM_RUNTIME_JOBS: ${value}; expected 1, 2, 3 or 4`);
}

export function runtimePlan(paths: readonly string[], checks = discoverChecks()) {
  const runtime = new Map(checks.filter(check => check.owner === "runtime").map(check => [check.path, check]));
  if (new Set(paths).size !== paths.length || paths.some(path => !runtime.has(path))) throw new Error("Invalid runtime file selection");
  const isolated = paths.filter(path => runtime.get(path)?.isolation === "process");
  const independent = new Set(isolated);
  return { serial: paths.filter(path => !independent.has(path)), isolated };
}

export function runtimeBatches(plan: ReturnType<typeof runtimePlan>): string[][] {
  const rank = new Map(isolatedDispatchPriority.map((path, index) => [path, index]));
  const isolated = plan.isolated.toSorted((a, b) => (rank.get(a) ?? isolatedDispatchPriority.length) - (rank.get(b) ?? isolatedDispatchPriority.length));
  const serial = plan.serial.length ? [plan.serial] : [];
  return serial.concat(isolated.map(path => [path]));
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

export const runtimeScratchPrefix = "bw-rt-";

export function workerSlotTmpDir(parent: string, slot: number): string {
  return join(parent, `s${slot}`);
}

function workerEnv(base: NodeJS.ProcessEnv, slot: number): NodeJS.ProcessEnv {
  const parent = base.TMPDIR;
  if (!parent) return base;
  const dir = workerSlotTmpDir(parent, slot);
  mkdirSync(dir, { recursive: true });
  return { ...base, TMPDIR: dir };
}

// No process control here: the existing supervisor owns this worker and every descendant.
export async function dispatchRuntime(
  plan: ReturnType<typeof runtimePlan>,
  run?: (paths: readonly string[]) => Promise<number>,
  jobs: RuntimeJobs = 2,
): Promise<number> {
  const batches = runtimeBatches(plan);
  let next = 0;
  let failure = 0;
  async function worker(slot: number): Promise<void> {
    const slotEnv = run ? undefined : workerEnv(process.env, slot);
    while (failure === 0) {
      const paths = batches[next++];
      if (paths === undefined) return;
      const status = run ? await run(paths) : await execute(checkCommand("runtime", paths), slotEnv);
      failure ||= status;
    }
  }
  await Promise.all(Array.from({ length: jobs }, (_, slot) => worker(slot)));
  return failure;
}

function removeScratch(scratch: string, state: string, pid: number | undefined): void {
  if (pid !== undefined && !existsSync(join(state, "status"))) throw new Error(`Runtime supervisor did not confirm drain; preserving scratch at ${scratch}`);
  rmSync(scratch, { recursive: true, force: true });
}

export async function runRuntimeChecks(paths: readonly string[], env = process.env, jobs: RuntimeJobs = 2): Promise<number> {
  // Validate before creating scratch or starting the supervisor. New files default to serial.
  runtimePlan(paths);
  if (process.platform !== "linux") throw new Error("Bounded runtime checks require the Linux process supervisor");
  const scratch = mkdtempSync(join(env.TMPDIR ?? tmpdir(), runtimeScratchPrefix));
  const state = join(scratch, "supervisor");
  mkdirSync(state);
  const supervisor = join(import.meta.dir, "run-with-timeout.mts");
  const command = [supervisor, "--state", state, "--until-exit", process.execPath, import.meta.filename, "--worker", "--jobs", String(jobs)].concat(paths);
  const child = spawn(process.execPath, command, {
    env: { ...env, TMPDIR: scratch, WASM_TABLE_TMP: scratch, RAYON_NUM_THREADS: jobs >= 3 ? "1" : "2" },
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
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--worker") {
    const hasJobs = rest[0] === "--jobs";
    const jobs = hasJobs ? runtimeJobs(rest[1] ?? "") : 2;
    const paths = hasJobs ? rest.slice(2) : rest;
    process.exitCode = await dispatchRuntime(runtimePlan(paths), undefined, jobs);
  } else if (mode === undefined) {
    process.exitCode = await runRuntimeChecks(selectChecks("runtime"));
  } else {
    throw new Error("Usage: runtime-file-checks.ts [--worker [--jobs N] <runtime paths...>]");
  }
}
