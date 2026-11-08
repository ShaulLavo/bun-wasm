import { bounded } from "./execute";
export async function withSignals<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Matrix interrupted"));
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  parent?.addEventListener("abort", interrupt, { once: true });
  if (parent?.aborted) interrupt();
  try { return await operation(controller.signal); }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); parent?.removeEventListener("abort", interrupt); }
}
async function reap(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { await child.exited; return; }
  child.kill("SIGTERM");
  try { await bounded(() => child.exited, 3000); }
  catch { child.kill("SIGKILL"); await bounded(() => child.exited, 3000); }
}
export async function ownedCommand(args: string[], signal?: AbortSignal, timeoutMs = 120_000, inherit = false, allowed: readonly number[] = [0]): Promise<string> {
  signal?.throwIfAborted();
  const [name, ...rest] = args;
  if (!name) throw new Error("Missing command executable");
  const executable = Bun.which(name, { PATH: process.env.PATH }) ?? name;
  const child = Bun.spawn([executable].concat(rest), { env: process.env, stdout: inherit ? "inherit" : "pipe", stderr: "pipe" });
  const interrupt = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", interrupt, { once: true });
  try {
    const output = inherit ? Promise.resolve("") : new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const [code, text, error] = await bounded(() => Promise.all([child.exited, output, errors]), timeoutMs, signal);
    if (!allowed.includes(code)) throw new Error(`${args[0]} exited ${code}: ${error.slice(-2000)} ${text.slice(-1000)}`);
    return text;
  } finally { signal?.removeEventListener("abort", interrupt); await reap(child); }
}
