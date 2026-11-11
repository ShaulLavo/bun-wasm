import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadavg } from "node:os";
import { array, canonical, json, number, object, parsePlan, sha256, string, verifyInputs, type Plan } from "./input";

const marker = "BUN_WASM_PERF_RESULT ";

function counterResult(path: string) {
  const result = object(json(path));
  if (result.valid !== true || result.exit !== 0) throw new Error(`counter/command failed: ${canonical(result)}`);
  for (const key of ["instructions", "cycles", "wallSeconds", "userSeconds", "systemSeconds"]) number(result[key]);
  if (number(result.instructions) === 0 || number(result.cycles) === 0) throw new Error("zero counter");
  const events = array(result.events).map(object);
  if (events.length === 0) throw new Error("missing counter events");
  for (const event of events) {
    const enabled = number(event.enabledNs), running = number(event.runningNs);
    if (running > enabled || enabled > 0 && running / enabled < 0.99 || enabled === 0 && number(event.value) !== 0) throw new Error("invalid counter coverage");
  }
  return result;
}

function resultFromOutput(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  if (lines.length !== 1) throw new Error(`expected exactly one result marker, received ${lines.length}`);
  return object(JSON.parse(lines[0]!.slice(marker.length)));
}

export function checkResult(result: Record<string, unknown>, mode: string) {
  if (result.mode !== mode) throw new Error("wrong result mode");
  if (mode === "load") return;
  for (const key of ["fileList", "esmFileList", "warnings"]) array(result[key]);
  const counts = object(result.counts);
  for (const key of ["readFile", "readStringLength", "readlink", "stat", "ignore"]) number(counts[key]);
  if (Object.keys(object(result.stubUse)).length) throw new Error("unexpected stub use");
  for (const key of ["fileList", "esmFileList"]) {
    const files = array(result[key]).map(string);
    if (new Set(files).size !== files.length || canonical(files.toSorted()) !== canonical(files)) throw new Error(`invalid full ${key}`);
  }
}

async function execute(plan: Plan, out: string, mode: string) {
  const counter = join(out, "counter.json");
  const command = plan.command.map(arg => arg === "{mode}" ? mode : arg);
  const argv = ["-c", String(plan.cpu), plan.counter, counter, String(plan.timeoutSeconds)].concat(command);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const child = spawn("/usr/bin/taskset", argv, { cwd: plan.cwd, env: plan.env, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => { child.kill("SIGTERM"); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
  child.stdout.on("data", bytes => stdout.push(bytes));
  child.stderr.on("data", bytes => stderr.push(bytes));
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    const output = Buffer.concat(stdout).toString();
    writeFileSync(join(out, "stdout.txt"), output); writeFileSync(join(out, "stderr.txt"), Buffer.concat(stderr));
    if (code !== 0) throw new Error(`counter exited ${code}, see ${out}`);
    return { result: resultFromOutput(output), counter: counterResult(counter) };
  } finally {
    process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop);
  }
}

export async function capture(plan: Plan, out: string, oracle: unknown | null, temperature: "warmup" | "warm") {
  mkdirSync(out);
  const started = new Date().toISOString();
  const before = loadavg();
  writeFileSync(join(out, "inputs.json"), JSON.stringify(plan, null, 2) + "\n");
  try {
    const cacheEntriesBeforeControl = plan.cacheRoots.map(path => ({ path, entries: readdirSync(path).length }));
    verifyInputs(plan);
    const controlDir = join(out, "control"); mkdirSync(controlDir);
    const control = await execute(plan, controlDir, "control");
    if (canonical(control.result) !== canonical(plan.control)) throw new Error("positive control output changed in measured process context");
    const measured = await execute(plan, out, plan.mode);
    checkResult(measured.result, plan.mode);
    if (oracle !== null && canonical(measured.result) !== canonical(oracle)) throw new Error("complete result/count/warning equality failed");
    verifyInputs(plan);
    const record = { workload: plan.workload, mode: plan.mode, arm: plan.arm, configuration: plan.configuration, temperature,
      started, cacheEntriesBeforeControl, loadBefore: before, loadAfter: loadavg(), resultSha256: sha256(canonical(measured.result)), ...measured };
    writeFileSync(join(out, "result.json"), JSON.stringify(measured.result, null, 2) + "\n");
    writeFileSync(join(out, "run.json"), JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (error) {
    writeFileSync(join(out, "failure.json"), JSON.stringify({ started, error: String(error) }) + "\n");
    throw error;
  }
}

if (import.meta.main) {
  const [planPath, destination, oraclePath, temperature = "warmup"] = process.argv.slice(2);
  if (!planPath || !destination || !oraclePath) throw new Error("usage: capture.ts PLAN OUTPUT ORACLE.json|--establish-control [warmup|warm]");
  if (temperature !== "warmup" && temperature !== "warm") throw new Error("use warmup or warm; the positive control warms artifacts before workload capture");
  await capture(parsePlan(resolve(planPath)), resolve(destination), oraclePath === "--establish-control" ? null : json(resolve(oraclePath)), temperature);
}
