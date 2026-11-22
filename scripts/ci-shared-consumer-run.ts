import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

type StepResult = { label: string; kind: "native" | "browser"; status: number; output: Buffer };
type NativeStepResult = StepResult & { cleanupConfirmed: boolean };

const root = resolve(import.meta.dir, "..");

function runStep(label: string, kind: "native" | "browser", args: readonly string[], env: NodeJS.ProcessEnv): Promise<StepResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const suffix = signal ? [Buffer.from(`\n[terminated by ${signal}]\n`)] : [];
      resolvePromise({ label, kind, status: code ?? 1, output: Buffer.concat(chunks.concat(suffix)) });
    });
  });
}

function engineEnv(engine: string, kind: "native" | "browser", baseTemp: string, inputsDir: string, launcher: string): NodeJS.ProcessEnv {
  const scratch = join(baseTemp, `shared-${engine}-${kind}`);
  mkdirSync(scratch, { recursive: true });
  return {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    BUN_WASM_PROFILE_PROGRAM: join(inputsDir, `program-${engine}`, "bun.wasm"),
    BUN_WASM_BROWSER_SITE: join(inputsDir, "browser"),
    BUN_WASM_PREPARED_SHARED_SITE: "1",
    BUN_WASM_LAUNCHER: launcher,
    ...(kind === "native" ? { BUN_WASM_TRACE: "1" } : {}),
  };
}

function nativeCommand(deadlineEpoch: number, statePath: string): { args: string[]; expired: boolean } {
  const remaining = deadlineEpoch - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return { args: [], expired: true };
  return {
    expired: false,
    args: ["bun", join(root, "scripts/run-with-timeout.mts"), "--state", statePath, String(remaining), "bun", join(root, "scripts/test-checks.ts"), "native", "--profile", "shared-group"],
  };
}

function browserCommand(engine: string, deadlineEpoch: number): { args: string[]; expired: boolean } {
  const cap = engine === "spidermonkey" ? 1320 : 420;
  const remaining = deadlineEpoch - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return { args: [], expired: true };
  const limit = Math.min(remaining, cap);
  return {
    expired: false,
    args: ["bun", join(root, "scripts/run-with-timeout.mts"), String(limit), "bun", join(root, "scripts/test-checks.ts"), "browser-guest", "--profile", "shared-group"],
  };
}

async function runNativeFor(engine: string, deadlineEpoch: number, temp: string, inputsDir: string, launcher: string): Promise<NativeStepResult> {
  const statePath = join(temp, `shared-native-run-${engine}`);
  rmSync(statePath, { recursive: true, force: true });
  mkdirSync(statePath, { recursive: true });
  const cmd = nativeCommand(deadlineEpoch, statePath);
  if (cmd.expired) {
    rmSync(statePath, { recursive: true, force: true });
    return { label: `${engine} native`, kind: "native", status: 124, output: Buffer.from("Shared native setup exhausted its budget\n"), cleanupConfirmed: false };
  }
  const result = await runStep(`${engine} native`, "native", cmd.args, engineEnv(engine, "native", temp, inputsDir, launcher));
  const cleanupConfirmed = existsSync(join(statePath, "status"));
  rmSync(statePath, { recursive: true, force: true });
  return { ...result, cleanupConfirmed };
}

async function runBrowserFor(engine: string, deadlineEpoch: number, temp: string, inputsDir: string, launcher: string): Promise<StepResult> {
  const cmd = browserCommand(engine, deadlineEpoch);
  if (cmd.expired) return { label: `${engine} browser`, kind: "browser", status: 124, output: Buffer.from("Shared browser setup exhausted its budget\n") };
  return runStep(`${engine} browser`, "browser", cmd.args, engineEnv(engine, "browser", temp, inputsDir, launcher));
}

async function runEngineSequential(engine: string, nativeDeadline: number, browserDeadline: number, temp: string, inputsDir: string, launcher: string): Promise<StepResult[]> {
  const nativeResult = await runNativeFor(engine, nativeDeadline, temp, inputsDir, launcher);
  if (!nativeResult.cleanupConfirmed) {
    return [nativeResult, { label: `${engine} browser`, kind: "browser", status: 1, output: Buffer.from("Shared native process cleanup could not be confirmed\n") }];
  }
  const browserResult = await runBrowserFor(engine, browserDeadline, temp, inputsDir, launcher);
  return [nativeResult, browserResult];
}

async function runSpiderMonkeyConcurrent(deadline: number, temp: string, inputsDir: string, launcher: string): Promise<StepResult[]> {
  const [nativeResult, browserResult] = await Promise.all([
    runNativeFor("spidermonkey", deadline, temp, inputsDir, launcher),
    runBrowserFor("spidermonkey", deadline, temp, inputsDir, launcher),
  ]);
  if (nativeResult.cleanupConfirmed) return [nativeResult, browserResult];
  return [nativeResult, browserResult, { label: "spidermonkey native cleanup", kind: "native", status: 1, output: Buffer.from("Shared native process cleanup could not be confirmed\n") }];
}

async function main(): Promise<void> {
  const group = process.argv[2];
  const temp = process.env.RUNNER_TEMP ?? process.env.TMPDIR;
  const inputsDir = process.env.SHARED_PROOF_INPUTS_DIR;
  const launcher = process.env.BUN_WASM_LAUNCHER;
  const started = Number(process.env.SHARED_STARTED ?? "0");
  const budgetSeconds = Number(process.env.SHARED_CHECK_SECONDS ?? "1800");
  if (!group || !temp || !inputsDir || !launcher || !Number.isFinite(started) || started <= 0) {
    throw new Error("Usage: ci-shared-consumer-run.ts <quickjs-jsc|spidermonkey>");
  }
  const deadline = started + budgetSeconds;
  let results: StepResult[];
  if (group === "quickjs-jsc") {
    const [qjs, jsc] = await Promise.all([
      runEngineSequential("quickjs", deadline, deadline, temp, inputsDir, launcher),
      runEngineSequential("jsc", deadline, deadline, temp, inputsDir, launcher),
    ]);
    results = qjs.concat(jsc);
  } else if (group === "spidermonkey") {
    results = await runSpiderMonkeyConcurrent(deadline, temp, inputsDir, launcher);
  } else {
    throw new Error(`Unknown shared consumer group: ${group}`);
  }
  let failed = 0;
  for (const result of results) {
    process.stdout.write(`::group::Shared ${result.label}\n`);
    process.stdout.write(result.output);
    process.stdout.write("::endgroup::\n");
    if (result.status !== 0) {
      process.stdout.write(`::error title=Shared ${result.label}::Exited with status ${result.status}\n`);
      failed = 1;
    }
  }
  process.exitCode = failed;
}

if (import.meta.main) await main();
