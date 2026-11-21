import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { state, type State } from "./model";
import { status } from "./scheduler";

export async function atomic(path: string, content: string): Promise<void> {
  const file = await open(`${path}.tmp`, "w", 0o600);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
  await rename(`${path}.tmp`, path);
}

export async function save(directory: string, value: State): Promise<void> {
  await mkdir(directory, { recursive: true });
  await atomic(join(directory, "state.json"), JSON.stringify(value, null, 2) + "\n");
  const handle = await open(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
  await atomic(join(directory, "STATUS.md"), status(value));
}

export async function load(directory: string, since?: string): Promise<State> {
  try {
    const result = state(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
    if (since && since !== result.since) throw new Error("Activation differs from durable state; use a separate report directory");
    return result;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    if (!since) throw new Error("First enrollment requires --since=<activation UTC>");
    return { schema: 1, since, polledAt: null, error: null, mac: { kind: "reachable" }, jobs: [] };
  }
}
