import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type Observation = { kind: "observed"; value: unknown } | { kind: "unavailable"; reason: string };
export type RecordExecution = (name: string, value: unknown) => void;

export function beginExecutionInterval(record: RecordExecution, name: string, scope: string): () => void {
  const before = { beforeMs: performance.now(), unit: "ms", clock: "controller performance.now", scope };
  record(name, { kind: "pending", ...before, reason: "Interval did not reach completion" });
  return () => record(name, { kind: "completed", ...before, afterMs: performance.now() });
}

export async function captureExecution<T>(output: string, fields: string[], run: (record: RecordExecution) => Promise<T>): Promise<T> {
  const observations: Record<string, Observation> = Object.fromEntries(fields.map(name => [name, { kind: "unavailable", reason: "Execution did not reach this observation" }]));
  const record: RecordExecution = (name, value) => { observations[name] = { kind: "observed", value }; };
  let status = "failed";
  let failure: string | null = null;
  try {
    const result = await run(record);
    status = "completed";
    return result;
  } catch (error) { failure = String(error); throw error; }
  finally { await writeFile(join(output, "execution.json"), JSON.stringify({ schema: 1, status, failure, observations }, null, 2) + "\n"); }
}
