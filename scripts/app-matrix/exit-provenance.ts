export interface RuntimeExit {
  reason: string;
  code: number;
  stack: string | null;
  loop: Record<string, number> | null;
}

function runtimeExit(value: unknown): RuntimeExit | null {
  if (!value || typeof value !== "object") return null;
  if (!("reason" in value) || typeof value.reason !== "string") return null;
  if (!("code" in value) || typeof value.code !== "number") return null;
  if (!("stack" in value) || value.stack !== null && typeof value.stack !== "string") return null;
  if (!("loop" in value)) return null;
  let loop: Record<string, number> | null = null;
  if (value.loop !== null) {
    if (typeof value.loop !== "object") return null;
    loop = {};
    for (const [name, count] of Object.entries(value.loop)) {
      if (typeof count !== "number") return null;
      loop[name] = count;
    }
  }
  return { reason: value.reason, code: value.code, stack: value.stack, loop };
}

export function exitProvenance(result: { code: number | null; signal?: string | null; timedOut?: boolean; output: string }) {
  const exits: RuntimeExit[] = [];
  for (const line of result.output.split("\n")) {
    if (!line.startsWith("[bun-wasm:exit] ")) continue;
    try {
      const record = runtimeExit(JSON.parse(line.slice("[bun-wasm:exit] ".length)));
      if (record) exits.push(record);
    } catch { /* A killed writer may leave its last line incomplete. */ }
  }
  return { exit: result.code, signal: result.signal ?? null, timedOut: result.timedOut ?? false, runtimeExits: exits };
}
