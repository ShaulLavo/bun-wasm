import { hasOwnedTab, ordinarySnapshot, ownedTabClose, privateSnapshot, proveTabClosed, proveTabsUnchanged, safariNodes } from "./iphone-tab-snapshot";
import { iphoneSafari, prepareIphoneSafari } from "./iphone-setup";

export type NativeCommand = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;

export async function closeIphoneTab(command: NativeCommand, title: string | null, deadline: number): Promise<void> {
  const lifetime = new AbortController();
  const expiryReason = new Error("iPhone cleanup deadline expired");
  const admission = { signal: lifetime.signal, deadline, expiryReason };
  if (deadline <= Date.now()) throw expiryReason;
  const timer = setTimeout(() => lifetime.abort(expiryReason), deadline - Date.now());
  let commandFailed = false;
  const bound: NativeCommand = async (args, timeoutMs, signal) => {
    try {
      const output = await command(args, timeoutMs, signal);
      if (args[0] === "batch") safariNodes(output, JSON.parse(args[2]!).map((step: { command: string }) => step.command));
      return output;
    }
    catch (error) { commandFailed = true; throw error; }
  };
  try {
    const safari = iphoneSafari(bound, admission);
    let nodes = await safari.ordinary(await safari.overview());
    if (title !== null) nodes = await closeOwnedTab(safari, nodes, title);
    await safari.finish(nodes);
  } catch (error) {
    if (commandFailed || lifetime.signal.aborted || Date.now() >= deadline) throw error;
    try { await prepareIphoneSafari(bound, admission); }
    catch (restoration) { throw new AggregateError([error, restoration], "Safari cleanup and ordinary restoration failed", { cause: error }); }
    throw error;
  } finally { clearTimeout(timer); lifetime.abort(); }
}

async function closeOwnedTab(safari: ReturnType<typeof iphoneSafari>, nodes: ReturnType<typeof safariNodes>, title: string) {
  if (!title) throw new Error("Missing task Safari tab identity; cleanup is unproved");
  const normal = ordinarySnapshot(nodes);
  const isOrdinary = hasOwnedTab(normal, title);
  if (!isOrdinary) nodes = await safari.privateGroup(nodes);
  const read = isOrdinary ? ordinarySnapshot : privateSnapshot;
  const before = read(nodes);
  const ref = ownedTabClose(before, title);
  nodes = await safari.snapshot([{ command: "press", input: { target: { kind: "ref", ref }, settle: true } }]);
  proveTabClosed(before, read(nodes), title);
  if (isOrdinary) return nodes;
  nodes = await safari.ordinary(nodes);
  proveTabsUnchanged(normal, ordinarySnapshot(nodes));
  return nodes;
}
