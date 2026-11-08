import assert from "node:assert/strict";
import { object, type ArmDescriptor } from "./engine-arm-registry.ts";

export function compileRequest(arm: Pick<ArmDescriptor, "label" | "sourceCommit" | "sourceTree" | "program">, source: "launcher" | "chromium", runId: string) {
  assert.ok(runId.length > 0, "compile observation needs a run identity");
  return { schemaVersion: 1, source, runId, armLabel: arm.label, sourceCommit: arm.sourceCommit, sourceTree: arm.sourceTree,
    program: arm.program, phase: "module-compilation", clock: "monotonic" } as const;
}
export type CompileRequest = ReturnType<typeof compileRequest>;

// Only host instrumentation can supply these spans. Missing instrumentation is
// unavailable, not zero; download, deserialization and bootstrap are excluded.
export function compileDuration(value: unknown, expected: CompileRequest): number | null {
  if (value === null) return null;
  const observation = object(value);
  for (const [key, field] of Object.entries(expected)) assert.deepEqual(observation[key], field, `compile observation differs at ${key}`);
  assert.ok(Array.isArray(observation.spans), "missing direct compiler spans");
  const observedSpans: unknown[] = observation.spans;
  const parts = expected.program.kind === "single" ? ["core"] : ["core", "side"];
  assert.equal(observedSpans.length, parts.length, "compile spans must cover every module exactly once");
  const durations = parts.map(part => {
    const spans = observedSpans.filter((value: unknown) => object(value).part === part);
    assert.equal(spans.length, 1, `missing or duplicate ${part} compiler span`);
    const span = object(spans[0]);
    assert.ok(typeof span.startMs === "number" && Number.isFinite(span.startMs) && span.startMs >= 0, "invalid compiler span start");
    assert.ok(typeof span.endMs === "number" && Number.isFinite(span.endMs) && span.endMs >= span.startMs, "invalid compiler span end");
    return span.endMs - span.startMs;
  });
  const duration = durations.reduce((total, duration) => total + duration, 0);
  assert.ok(Number.isFinite(duration), "invalid total compiler duration");
  return duration;
}
