import { ownedCommand } from "../goals-matrix/lifetime";
import { object, text } from "../goals-matrix/evidence";

export function queueTicket(value: unknown, thread: string, expected?: string): string {
  const holder = object(object(value).holder);
  if (holder.thread !== thread || holder.mode !== "run" || holder.phase !== "held" || typeof holder.group_id !== "number") throw new Error("The requested Mac FIFO thread does not hold a supervised workload");
  const ticket = text(holder.id);
  if (expected !== undefined && expected !== ticket) throw new Error("Mac FIFO admission changed during smoke");
  return ticket;
}
export async function verifyMacAdmission(thread: string, expected?: string, signal?: AbortSignal): Promise<string> {
  const script = 'python3 "$HOME/.agents/skills/machine-fleet/scripts/availability.py" check --owner-only && "$HOME/.bun/bin/bun" "$HOME/.agents/skills/machine-fleet/scripts/mac-queue.ts" status';
  const output = await ownedCommand(["mesh", "ssh", "mac", "--", "zsh", "-lc", script], signal, 30_000);
  return queueTicket(JSON.parse(output), thread, expected);
}
