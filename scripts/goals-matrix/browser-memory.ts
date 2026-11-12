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

function launchFailureFacts(engine: string): string {
  const getter: unknown = Reflect.get(globalThis, "__bunRetainedMemorySnapshots");
  if (typeof getter !== "function") return "";
  const snapshots: unknown = getter();
  if (!Array.isArray(snapshots)) throw new TypeError("Invalid retained memory snapshots");
  const launches = snapshots.filter((snapshot: unknown) => snapshot !== null && typeof snapshot === "object"
    && "engine" in snapshot && snapshot.engine === engine && "launchFailures" in snapshot
    && Array.isArray(snapshot.launchFailures) && snapshot.launchFailures.length > 0).slice(-128);
  return launches.length ? `\n\nBun immediate launch failure snapshots (reconciled API bookkeeping, not a native census or physical memory):\n${JSON.stringify(launches)}\n` : "";
}

/** Page-side facts are already frozen; do not request or wait for a worker sample. */
export async function launchFailureLog(transport: Pick<ScopedTransport, "useHost" | "evaluate">, engine: string): Promise<string> {
  try {
    await transport.useHost();
    return await transport.evaluate<string>(`(${launchFailureFacts.toString()})(${JSON.stringify(engine)})`, { observation: true });
  } catch { return "\n\nBun immediate launch failure snapshots unavailable: host observation failed.\n"; }
}
