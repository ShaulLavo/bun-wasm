import type { ScopedTransport } from "./transport";

async function browserTrapFacts(engine: string): Promise<string> {
  const getter: unknown = Reflect.get(globalThis, "__bunMemorySnapshots");
  if (typeof getter !== "function") return engine === "browser" ? "\n\nBrowser core trap memory snapshots unavailable: diagnostic hook is unavailable.\n" : "";
  const snapshots: unknown = await getter(engine, false);
  if (!Array.isArray(snapshots)) throw new TypeError("Invalid Browser memory snapshots");
  const traps = snapshots.filter((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== "object" || !("engine" in snapshot) || snapshot.engine !== "browser" || !("engineCounters" in snapshot)) return false;
    const counters: unknown = snapshot.engineCounters;
    return counters !== null && typeof counters === "object" && "browserCallTrapCapacityBytes" in counters;
  });
  const launches = snapshots.filter((snapshot: unknown) => snapshot !== null && typeof snapshot === "object"
    && "engine" in snapshot && snapshot.engine === engine && "launchFailures" in snapshot
    && Array.isArray(snapshot.launchFailures) && snapshot.launchFailures.length > 0);
  return (engine === "browser" && traps.length ? `\n\nBrowser core trap memory snapshots:\n${JSON.stringify(traps)}\n` : "")
    + (launches.length ? `\n\nBun immediate launch failure snapshots (reconciled API bookkeeping, not a native census or physical memory):\n${JSON.stringify(launches)}\n` : "");
}

/** Read retained trap and launch observations before disposing the owned host page. */
export async function browserTrapLog(transport: Pick<ScopedTransport, "useHost" | "evaluate">, engine: string): Promise<string> {
  try {
    await transport.useHost();
    return await transport.evaluate<string>(`(${browserTrapFacts.toString()})(${JSON.stringify(engine)})`, { observation: true });
  } catch { return engine === "browser" ? "\n\nBrowser core trap memory snapshots unavailable: host observation failed.\n" : "\n\nBun immediate launch failure snapshots unavailable: host observation failed.\n"; }
}
