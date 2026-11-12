import { batchSnapshot, ownedTabClose, proveTabClosed } from "./iphone-tab-snapshot";

export type NativeCommand = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;
type Step = { command: "press" | "snapshot"; input: Record<string, unknown> };

export async function closeIphoneTab(command: NativeCommand, title: string, deadline: number): Promise<void> {
  const lifetime = new AbortController();
  const remaining = () => {
    lifetime.signal.throwIfAborted();
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("iPhone cleanup deadline expired");
    return timeoutMs;
  };
  const timer = setTimeout(() => lifetime.abort(new Error("iPhone cleanup deadline expired")), remaining());
  async function batch(steps: Step[]) {
    const output = await command(["batch", "--steps", JSON.stringify(steps), "--on-error", "stop", "--json"], remaining(), lifetime.signal);
    remaining();
    return batchSnapshot(output, steps.map(step => step.command));
  }
  try {
    await command(["press", 'label="More" role=button'], remaining(), lifetime.signal);
    const before = await batch([
      { command: "press", input: { target: { kind: "selector", selector: 'label="All Tabs"' } } },
      { command: "snapshot", input: { interactiveOnly: true } },
    ]);
    const ref = ownedTabClose(before, title);
    const after = await batch([
      { command: "press", input: { target: { kind: "ref", ref } } },
      { command: "snapshot", input: { interactiveOnly: true } },
    ]);
    proveTabClosed(before, after, title);
  } finally { clearTimeout(timer); lifetime.abort(); }
}
