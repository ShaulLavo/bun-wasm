export type NativeCommand = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;

export async function closeIphoneTab(command: NativeCommand, title: string, deadline: number): Promise<void> {
  const lifetime = new AbortController();
  const remaining = () => {
    lifetime.signal.throwIfAborted();
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("iPhone cleanup deadline expired");
    return timeoutMs;
  };
  const timer = setTimeout(() => lifetime.abort(new Error("iPhone cleanup deadline expired")), remaining());
  const run = (args: string[]) => command(args, remaining(), lifetime.signal);
  try {
    await run(["press", 'label="More" role=button']);
    await run(["press", 'label="All Tabs"']);
    const snapshot = await run(["snapshot", "-i"]);
    const lines = snapshot.split("\n");
    const matches = lines.flatMap((line, index) => line.includes(`[button] ${JSON.stringify(title)}`) ? [index] : []);
    const index = matches.length === 1 ? matches[0] : undefined;
    const close = index !== undefined ? /^(@e\d+(?:~s\d+)?) \[button\] "Close"/.exec(lines[index + 1] ?? "")?.[1] : undefined;
    if (!close) throw new Error("Cannot identify the task's Safari tab for cleanup");
    await run(["press", close]);
    const after = await run(["snapshot", "-i"]);
    if (after.includes(`[button] ${JSON.stringify(title)}`)) throw new Error("Task Safari tab is still present after native close");
  } finally { clearTimeout(timer); lifetime.abort(); }
}
