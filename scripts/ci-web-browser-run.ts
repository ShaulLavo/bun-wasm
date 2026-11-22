import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { webBrowserShards } from "./ci-web-browser-shards.ts";

type Task = { label: string; command: readonly string[]; env?: NodeJS.ProcessEnv };
type TaskResult = { label: string; status: number; output: Buffer };

const root = resolve(import.meta.dir, "..");
const web = join(root, "web");

function runTask(task: Task): Promise<TaskResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(task.command[0]!, task.command.slice(1), {
      cwd: web,
      env: { ...process.env, ...task.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const suffix = signal ? [Buffer.from(`\n[terminated by ${signal}]\n`)] : [];
      resolvePromise({ label: task.label, status: code ?? 1, output: Buffer.concat(chunks.concat(suffix)) });
    });
  });
}

async function runSequence(tasks: readonly Task[]): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const task of tasks) results.push(await runTask(task));
  return results;
}

function batchTask(name: string, timeoutSeconds: number, temp: string): Task {
  return {
    label: `web-browser (${name})`,
    command: ["bun", join(root, "scripts/run-with-timeout.mts"), String(timeoutSeconds), "bun", join(root, "scripts/test-checks.ts"), "web-browser", "--batch", name],
    env: { EDITOR_SCRATCH_ROOT: temp },
  };
}

function processTasks(bundles: string, temp: string): Task[] {
  const browsers = ["chromium", "firefox", "webkit"] as const;
  return browsers.flatMap(browser => [
    {
      label: `processes (${browser}, supervisor)`,
      command: ["bun", join(root, "scripts/run-with-timeout.mts"), "300", "bun", "tests/browser-process.ts", browser],
      env: { BUN_WASM_PROCESS_BUNDLES: bundles, PROCESS_SMOKE_PORT: "4186", TMPDIR: temp },
    },
    {
      label: `processes (${browser}, interrupt)`,
      command: ["bun", join(root, "scripts/run-with-timeout.mts"), "300", "bun", "tests/browser-interrupt.ts", browser],
      env: { BUN_WASM_PROCESS_BUNDLES: bundles, INTERRUPT_SCRATCH_ROOT: temp },
    },
    {
      label: `processes (${browser}, runtime-proc)`,
      command: ["bun", join(root, "scripts/run-with-timeout.mts"), "300", "bun", "tests/browser-runtime-proc.ts", browser],
      env: { BUN_WASM_PROCESS_BUNDLES: bundles, BUN_WASM_RUNTIME_PROC_BUNDLE: join(bundles, "runtime-proc"), TMPDIR: temp },
    },
  ]);
}

async function main(): Promise<void> {
  const temp = process.env.RUNNER_TEMP ?? process.env.TMPDIR;
  const bundles = process.env.BUN_WASM_PROCESS_BUNDLES;
  if (!temp || !bundles) throw new Error("Missing RUNNER_TEMP/TMPDIR or BUN_WASM_PROCESS_BUNDLES");
  const shards = webBrowserShards();
  const streams: Task[][] = shards.map(shard =>
    [shard.batch, shard.pairedBatch].filter(Boolean).map(name => batchTask(name, shard.timeoutSeconds, temp)),
  );
  const smoke: Task[] = [
    { label: "web-host (--smoke)", command: ["bash", join(root, "scripts/test-web-host.sh"), "--smoke"], env: { EDITOR_SCRATCH_ROOT: temp } },
  ];
  const smokeAndProcesses = smoke.concat(processTasks(bundles, temp));
  streams.push(smokeAndProcesses);
  const outputs = (await Promise.all(streams.map(runSequence))).flat();
  let failed = 0;
  for (const result of outputs) {
    process.stdout.write(`::group::${result.label}\n`);
    process.stdout.write(result.output);
    process.stdout.write("::endgroup::\n");
    if (result.status !== 0) {
      process.stdout.write(`::error title=${result.label}::Exited with status ${result.status}\n`);
      failed = 1;
    }
  }
  process.exitCode = failed;
}

if (import.meta.main) await main();
