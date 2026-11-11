import type { Transport } from "./transport";

async function browserTrapFacts(): Promise<string> {
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") return "";
  const snapshots: unknown = await getter("browser", false);
  if (!Array.isArray(snapshots)) throw new TypeError("Invalid Browser memory snapshots");
  const traps = snapshots.filter(snapshot => {
    if (!snapshot || typeof snapshot !== "object" || snapshot.engine !== "browser") return false;
    const counters: unknown = snapshot.engineCounters;
    return counters !== null && typeof counters === "object" && "browserCallTrapCapacityBytes" in counters;
  });
  return traps.length ? `\n\nBrowser core trap memory snapshots:\n${JSON.stringify(traps)}\n` : "";
}

/** Read the retained trap observations while the owned host page is still available. */
export async function browserTrapLog(transport: Pick<Transport, "useHost" | "evaluate">, engine: string): Promise<string> {
  if (engine !== "browser") return "";
  await transport.useHost();
  return transport.evaluate<string>(`(${browserTrapFacts.toString()})()`, { observation: true });
}
