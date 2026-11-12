import type { ScopedTransport } from "./transport";

async function browserTrapFacts(): Promise<string> {
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") return "\n\nBrowser core trap memory snapshots unavailable: diagnostic hook is unavailable.\n";
  const snapshots: unknown = await getter("browser", false);
  if (!Array.isArray(snapshots)) throw new TypeError("Invalid Browser memory snapshots");
  const traps = snapshots.filter((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== "object" || !("engine" in snapshot) || snapshot.engine !== "browser" || !("engineCounters" in snapshot)) return false;
    const counters: unknown = snapshot.engineCounters;
    return counters !== null && typeof counters === "object" && "browserCallTrapCapacityBytes" in counters;
  });
  return traps.length ? `\n\nBrowser core trap memory snapshots:\n${JSON.stringify(traps)}\n` : "";
}

/** Read the retained trap observations while the owned host page is still available. */
export async function browserTrapLog(transport: Pick<ScopedTransport, "useHost" | "evaluate">, engine: string): Promise<string> {
  if (engine !== "browser") return "";
  try {
    await transport.useHost();
    return await transport.evaluate<string>(`(${browserTrapFacts.toString()})()`, { observation: true });
  } catch { return "\n\nBrowser core trap memory snapshots unavailable: host observation failed.\n"; }
}
