import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Transport } from "../goals-matrix/transport";
import { command } from "../goals-matrix/playground";
import { observeProcess } from "./observe-process";

type Observer = Awaited<ReturnType<typeof observeProcess>>;
export async function startObservation(root: number | undefined, scope: string): Promise<{ observer: Observer | null; unavailable: string | null }> {
  try {
    if (root === undefined) throw new Error("Exact subprocess root is unavailable");
    return { observer: await observeProcess(root, scope), unavailable: null };
  } catch (error) { return { observer: null, unavailable: String(error) }; }
}
export async function finishObservation(started: Awaited<ReturnType<typeof startObservation>>, output: string, window?: { beforeMs: number; afterMs: number }) {
  try {
    const result = started.observer ? await started.observer.stop(window) : { kind: "unavailable", reason: started.unavailable };
    await writeFile(output, JSON.stringify(result));
    return result;
  } catch (error) {
    const result = { kind: "unavailable", reason: String(error) };
    await writeFile(output, JSON.stringify(result)).catch(() => {});
    return result;
  }
}
export async function startupControls(transport: Transport, output: string, timeoutMs: number, requiresPreparation: boolean) {
  const fixture = await readFile("scripts/performance/fixtures/sharing-startup.ts", "utf8");
  await transport.evaluate(`playground.fs.writeFile('/home/user/.perf-startup.ts', ${JSON.stringify(fixture)})`);
  const controls: { mode: string; status: string; reason: string | null; result: unknown; observation: unknown; observerCoverage: ReturnType<typeof observerCoverage>; preparations: ReturnType<typeof preparationEvents> }[] = [];
  for (const mode of ["leaf", "root"]) {
    const observer = await startObservation(transport.processRoot, `Browser subprocess tree; ${mode === "leaf" ? "root CPU/fs" : "child and nested CPU/fs"} control; harness and asset server excluded`);
    let result: unknown = null, reason: string | null = null;
    try { result = await command(transport, `bun .perf-startup.ts ${mode}`, timeoutMs); }
    catch (error) { reason = String(error); }
    const observation = await finishObservation(observer, join(output, `control-${mode}-observation.json`));
    if (reason === null && !validControlOutput(result, mode)) reason = "Required root/child/nested activity output is missing";
    const preparations = preparationEvents(result);
    if (requiresPreparation && reason === null && preparations.length < (mode === "leaf" ? 1 : 5)) reason = "Per-worker preparation evidence missing";
    controls.push({ mode, status: reason ? "fail" : "pass", reason, result, observation: "kind" in observation ? observation.kind : "unknown", observerCoverage: observerCoverage(observation, reason), preparations });
  }
  await startupLatency(transport, output, timeoutMs);
  await transport.evaluate("playground.fs.remove('/home/user/.perf-startup.ts')");
  await transport.evaluate("playground.fs.remove('/home/user/.perf-activity')");
  return controls;
}

function validControlOutput(result: unknown, mode: string): boolean {
  if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string") return false;
  if (mode === "leaf") return result.output.includes("PERF_ACTIVITY");
  return result.output.includes("PERF_CHILD") && result.output.includes("PERF_NESTED") && result.output.includes("PERF_ROOT");
}

function observerCoverage(observation: Awaited<ReturnType<typeof finishObservation>>, reason: string | null) {
  if (reason || !("summary" in observation)) return { cpu: "unavailable", queue: "unavailable", reason: reason ?? "Observer failed" };
  return { cpu: (observation.summary.observedCpuSeconds ?? 0) > 0 ? "positive" : "unavailable", queue: "unavailable", queueControl: observation.summary.queueControl,
    reason: "Coverage is this browser tree during the actual root/child fixture. Individual guest thread roles are not established; memory/faults are sampled, not complete lifetime totals." };
}

export function preparationEvents(result: unknown) {
  if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string") return [];
  return Array.from(result.output.matchAll(/\[bunwasm-perf\] (\{[^\n]*\})/g), match => parseRecord(match[1]!)).filter((value: unknown): value is { event: "unshared-prepare"; beforeMs: number; afterMs: number; sourceBytes: number } => {
    return value !== null && typeof value === "object" && "event" in value && value.event === "unshared-prepare" && "beforeMs" in value && typeof value.beforeMs === "number" && "afterMs" in value && typeof value.afterMs === "number" && value.afterMs >= value.beforeMs && "sourceBytes" in value && typeof value.sourceBytes === "number";
  });
}

function parseRecord(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

async function startupLatency(transport: Transport, output: string, timeoutMs: number) {
  try {
    const result = await command(transport, "bun .perf-startup.ts starts", timeoutMs);
    if (!result || typeof result !== "object" || !("output" in result) || typeof result.output !== "string" || !result.output.includes("PERF_STARTS") || !result.output.includes("PERF_TRIVIAL_NESTED")) throw new Error("Trivial child/nested output missing");
    await writeFile(join(output, "startup-latency.json"), JSON.stringify({ status: "pass", result, preparations: preparationEvents(result), scope: "Guest child and nested latencies only; never multiplied by inferred OS thread births" }));
  } catch (error) { await writeFile(join(output, "startup-latency.json"), JSON.stringify({ status: "unavailable", reason: String(error) })); }
}
