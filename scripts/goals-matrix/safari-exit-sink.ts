import { open } from "node:fs/promises";
import type { Sink } from "./safari-exit-observer";

export function exitJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Error ? { ...item, name: item.name, message: item.message } : item);
}

export async function jsonlSink(path: string): Promise<Sink> {
  const file = await open(path, "wx", 0o600);
  return {
    async write(entry, signal) {
      signal.throwIfAborted();
      await file.writeFile(exitJSON(entry) + "\n");
    },
    async close(signal) { signal.throwIfAborted(); await file.close(); },
  };
}
