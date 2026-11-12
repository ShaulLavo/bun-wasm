import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { capture } from "./capture";
import { canonical, json, number, parsePlan } from "./input";

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
  return { values, median, min: values[0], max: values.at(-1) };
}

export async function replay(beforePath: string, afterPath: string, oraclePath: string, out: string) {
  const before = parsePlan(beforePath), after = parsePlan(afterPath);
  if (before.arm === after.arm) throw new Error("arms need distinct labels");
  for (const key of ["workload", "mode", "cpu", "observer", "cwd"] as const) {
    if (before[key] !== after[key]) throw new Error(`mismatched comparison ${key}`);
  }
  if (canonical(before.env) !== canonical(after.env) || canonical(before.cacheRoots) !== canonical(after.cacheRoots)) throw new Error("comparison environment and cache roots must match");
  const sharedBefore = before.inputs.filter(input => input.role === "fixture");
  const sharedAfter = after.inputs.filter(input => input.role === "fixture");
  if (canonical(sharedBefore) !== canonical(sharedAfter)) throw new Error("comparison fixtures must match");
  mkdirSync(out);
  const oracle = json(oraclePath);
  const runs: Awaited<ReturnType<typeof capture>>[] = [];
  const schedule = [before, after, before, after, after, before];
  try {
    for (const [index, plan] of schedule.entries()) {
      const temperature = index < 2 ? "warmup" : "warm";
      runs.push(await capture(plan, join(out, `${index}-${plan.arm}`), oracle, temperature));
      writeFileSync(join(out, "runs.json"), JSON.stringify(runs, null, 2) + "\n");
    }
    const arms = [before, after].map(plan => {
      const warm = runs.filter(run => run.arm === plan.arm && run.temperature === "warm");
      return { arm: plan.arm, configuration: plan.configuration,
        instructions: distribution(warm.map(run => number(run.counter.instructions))),
        wallSeconds: distribution(warm.map(run => number(run.counter.wallSeconds))),
        cpuSeconds: distribution(warm.map(run => number(run.counter.userSeconds) + number(run.counter.systemSeconds))) };
    });
    writeFileSync(join(out, "summary.json"), JSON.stringify({ workload: before.workload, mode: before.mode,
      excluded: "one warmup per artifact; all successful records retained in runs.json", schedule: schedule.map(plan => plan.arm), arms }, null, 2) + "\n");
  } catch (error) {
    writeFileSync(join(out, "failure.json"), JSON.stringify({ error: String(error), successfulRuns: runs.length }) + "\n");
    throw error;
  }
}

if (import.meta.main) {
  const [before, after, oracle, out] = process.argv.slice(2);
  if (!before || !after || !oracle || !out) throw new Error("usage: replay.ts BEFORE.json AFTER.json ORACLE.json NEW_OUTPUT_ROOT");
  await replay(resolve(before), resolve(after), resolve(oracle), resolve(out));
}
