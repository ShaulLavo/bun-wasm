import { ownedCommand } from "../goals-matrix/lifetime";
import { object } from "../goals-matrix/evidence";

class AdmissionLost extends Error {}

export function queueTicket(value: unknown, thread: string, expected?: string): string {
  const status = object(value);
  if (status.ownerBusy === true) throw new AdmissionLost("The Mac is reserved by its owner");
  if (status.ownerBusy !== false) throw new Error("Mac FIFO status has no owner reservation field");
  const lock = object(status.lock);
  if (status.holder === null && (lock.kind === "free" || lock.kind === "legacy-or-unknown")) throw new AdmissionLost(`The Mac FIFO has no queue holder (${lock.kind})`);
  const holder = object(status.holder);
  const { id, mode, phase, share, group_id: group } = holder;
  if (typeof id !== "string" || !id || typeof holder.thread !== "string" || typeof mode !== "string" || typeof phase !== "string" || lock.kind !== "queue" || lock.ticket !== id) throw new Error("Mac FIFO status has inconsistent holder and lock fields");
  if (holder.thread !== thread || mode !== "run" || phase !== "held" || share !== null || typeof group !== "number" || !Number.isSafeInteger(group) || group <= 0) throw new AdmissionLost("The requested Mac FIFO thread does not hold a supervised exclusive workload");
  if (expected !== undefined && expected !== id) throw new AdmissionLost(`Mac FIFO admission changed during smoke from ${expected} to ${id}`);
  return id;
}

const statusCommand = '"$HOME/.bun/bin/bun" "$HOME/.agents/skills/machine-fleet/scripts/mac-queue.ts" status';

export async function verifyMacAdmission(thread: string, expected?: string, signal?: AbortSignal, warn = (message: string): void => { process.stderr.write(message + "\n"); }): Promise<string> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const output = await ownedCommand(["mesh", "ssh", "mac", "--", "zsh", "-lc", statusCommand], signal, 6_000);
      return queueTicket(JSON.parse(output), thread, expected);
    } catch (error) {
      if (error instanceof AdmissionLost) throw error;
      const message = `Mac FIFO status probe ${attempt} failed: ${String(error)}`;
      warn(message);
      signal?.throwIfAborted();
      errors.push(message);
    }
  }
  throw new Error(`Mac FIFO admission is unverified. ${errors.join(". ")}`);
}
