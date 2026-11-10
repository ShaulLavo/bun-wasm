import { homedir } from "node:os";
import { join } from "node:path";
import type { Options } from "./run";
import { ownedCommand, withSignals } from "./lifetime";

export type NativeAdmission = { lane: string; thread: string; expectedSeconds: number; waitSeconds: number; timeoutSeconds: number };
export function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function admission(config: Options): NativeAdmission {
  const value = config.nativeAdmission;
  if (!value?.lane.trim()) throw new Error("Native campaigns require --mac-lane");
  if (!value.thread.trim() || /[\r\n\0]/.test(value.thread) || Buffer.byteLength(value.thread) > 1024) throw new Error("Native campaigns require a nonempty, single-line T3 thread ID in --mac-thread");
  return value;
}
export function queuedNativeCommand(config: Options, command: string[], task: string, home = homedir()): string[] {
  const request = admission(config);
  return [join(home, ".bun/bin/bun"), join(home, ".agents/skills/machine-fleet/scripts/mac-queue.ts"), "run",
    "--lane", request.lane, "--thread", request.thread, "--task", task,
    "--expected-seconds", String(request.expectedSeconds), "--wait-seconds", String(request.waitSeconds), "--timeout-seconds", String(request.timeoutSeconds), "--"].concat(command);
}
export async function nativeQueueMember(): Promise<boolean> {
  const status: unknown = JSON.parse(await ownedCommand([join(homedir(), ".bun/bin/bun"), join(homedir(), ".agents/skills/machine-fleet/scripts/mac-queue.ts"), "status"]));
  if (!status || typeof status !== "object" || !("holder" in status)) throw new Error("Invalid installed Mac queue status");
  const holder = status.holder;
  if (!holder || typeof holder !== "object" || !("mode" in holder) || holder.mode !== "run" || !("group_id" in holder)) return false;
  const group = Number((await ownedCommand(["ps", "-o", "pgid=", "-p", String(process.pid)])).trim());
  return Number.isSafeInteger(group) && group > 1 && holder.group_id === group;
}
export async function requireNativeQueue(): Promise<void> {
  if (!await nativeQueueMember()) throw new Error("Native workload must run through the installed mac-queue.ts run CLI");
}
export async function runQueuedNative(config: Options, command: string[], task: string): Promise<number> {
  return withSignals(async signal => {
    signal.throwIfAborted();
    const child = Bun.spawn(queuedNativeCommand(config, command, task), { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    try { return await child.exited; }
    finally { signal.removeEventListener("abort", stop); }
  }, config.signal);
}
export function nativeQueueScript(config: Options, remote: string, home: string, args: string[]): string {
  const workload = `set -eu; cd ${quote(remote)}; printf started > queue-workload-started; export PATH="$HOME/.bun/bin:$PATH"; bun install --ignore-scripts; exec bun run.js ${args.map(quote).join(" ")}`;
  const command = queuedNativeCommand(config, ["/bin/zsh", "-lc", workload], `bun-wasm goals ${remote}`, home);
  // The shell waits for cancellation too. Only the installed supervisor can release admission.
  return `cd ${quote(remote)} || exit; queue_pid=; trap 'if [ -n "$queue_pid" ]; then kill -TERM "$queue_pid" 2>/dev/null; fi' HUP INT TERM; ${command.map(quote).join(" ")} & queue_pid=$!; wait "$queue_pid"; code=$?; trap '' HUP INT TERM; if kill -0 "$queue_pid" 2>/dev/null; then wait "$queue_pid"; code=$?; fi; printf '%s\\n' "$code" > queue-exit; exit "$code"`;
}
