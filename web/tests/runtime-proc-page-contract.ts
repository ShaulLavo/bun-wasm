export const runtimeProcRows = [
  { scenario: "pipes", mode: "automatic" },
  { scenario: "pipes", mode: "explicit" },
  { scenario: "job-wait", mode: "automatic" },
  { scenario: "job-wait", mode: "explicit" },
] as const;

export const runtimeProcIds = runtimeProcRows.map(row => `runtime-proc: ${row.scenario}/${row.mode}`);
export const runtimeProcLimits = Object.freeze({ commandMs: 160_000, resultMs: 40_000, pageMs: 20_000 });
export type RuntimeProcRequest = { databaseName: string };

export function runtimeProcFilesystemName(run: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(run)) throw new Error("invalid runtime-proc run ID");
  return `bun-runtime-proc-${run}`;
}

export function runtimeProcQuery(row: typeof runtimeProcRows[number]): Record<string, string> {
  return { slots: "off", ...(row.mode === "explicit" ? { explicit: "1" } : {}), ...(row.scenario === "job-wait" ? { "job-wait": "1" } : {}) };
}
