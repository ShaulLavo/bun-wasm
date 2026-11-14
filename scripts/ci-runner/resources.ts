import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { root } from "./host.ts";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid heavy-runner settings");
  return Object.fromEntries(Object.entries(value));
}

export function vmMemorySettings(value: unknown): Record<string, unknown> {
  const settings = record(value);
  const classes = record(settings.classes);
  const adjusted = Object.fromEntries(Object.entries(classes));
  for (const [name, required] of [["suite", 8192], ["browser", 10240]] as const) {
    const budget = record(classes[name]);
    if (typeof budget.ceilingMiB !== "number" || !Number.isSafeInteger(budget.ceilingMiB) || budget.ceilingMiB < required) throw new Error("Configured heavy-runner ceiling cannot fit CI VM");
    adjusted[name] = { ...budget, estimateMiB: required };
  }
  return { ...settings, classes: adjusted };
}

export async function prepareVmSettings(): Promise<string> {
  const settings: unknown = JSON.parse(await readFile("/work/heavy-runner/config.json", "utf8"));
  const directory = `${root}/heavy-settings`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/config.json.pending`;
  await writeFile(temporary, JSON.stringify(vmMemorySettings(settings)), { mode: 0o600 });
  await rename(temporary, `${directory}/config.json`);
  return directory;
}
