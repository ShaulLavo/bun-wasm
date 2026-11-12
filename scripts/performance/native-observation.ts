import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchProcess } from "./lifecycle-process";
import { startObservation, finishObservation } from "./sharing-controls";
import { bounded } from "../goals-matrix/bounded";
import type { Transport } from "../goals-matrix/transport";

export async function nativeObserverControls(executable: string, root: string, env: NodeJS.ProcessEnv, output: string, signal: AbortSignal) {
  const controls: { mode: string; exitCode: number | null; reason: string | null }[] = [];
  for (const mode of ["leaf", "root"]) controls.push(await nativeControl(executable, root, env, output, signal, mode));
  await writeFile(join(output, "native-observer-controls.json"), JSON.stringify(controls));
  return controls.every(control => control.reason === null);
}
export async function previewObserverControl(transport: Transport, output: string) {
  const observation = await startObservation(transport.processRoot, "Native preview browser subprocess tree; JavaScript page/worker CPU control; native server and controller excluded");
  let valid = false;
  try {
    await transport.evaluate(`(async () => {
      const spin = () => { const end = performance.now() + 500; while (performance.now() < end) Math.sqrt(Math.random()); };
      spin();
      const url = URL.createObjectURL(new Blob(['(' + spin.toString() + ')();postMessage("done")'], {type:'text/javascript'}));
      const worker = new Worker(url);
      try { await new Promise((resolve, reject) => { worker.onmessage = resolve; worker.onerror = reject; }); }
      finally { worker.terminate(); URL.revokeObjectURL(url); }
    })()`);
    valid = true;
  } catch (error) { await writeFile(join(output, "preview-control-error.json"), JSON.stringify({ unavailable: String(error) })); valid = false; }
  finally { valid = (await checkObservation(observation, join(output, "preview-observer-control.json"))) === null && valid; }
  return valid;
}

async function nativeControl(executable: string, root: string, env: NodeJS.ProcessEnv, output: string, signal: AbortSignal, mode: string) {
  const directory = join(output, `control-native-${mode}`);
  await mkdir(directory);
  const job = launchProcess([executable, resolve("scripts/performance/fixtures/sharing-startup.ts"), mode], root, env, directory);
  let observation: Awaited<ReturnType<typeof startObservation>> | null = null;
  let exitCode: number | null = null, reason: string | null = null;
  try {
    observation = await startObservation(job.child.pid, `Native ${mode} CPU/fs activity control subprocess tree; controller excluded`);
    exitCode = await bounded(() => job.exited, 30000, signal);
    const text = await readFile(join(directory, "stdout.txt"), "utf8");
    if (exitCode !== 0 || !text.includes(mode === "leaf" ? "PERF_ACTIVITY" : "PERF_NESTED")) throw new Error("Native root/child control output missing");
  } catch (error) { reason = String(error); }
  finally {
    if (observation) {
      reason ??= await checkObservation(observation, join(directory, "observation.json"));
    }
    await job.close();
  }
  return { mode, exitCode, reason };
}

async function checkObservation(observation: Awaited<ReturnType<typeof startObservation>>, path: string) {
  const result = await finishObservation(observation, path);
  return "summary" in result && result.summary.observedCpuSeconds > 0 ? null : "CPU observer positive control unavailable";
}
