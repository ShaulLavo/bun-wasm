import { ProcessErrno, ProcessError } from "waffle/proc/types";

// Adapted from Waffle browser/diagnostic.ts at a0a0f8794cde02410a11be38771b31cdbd3af89a.
// Node supplies immediate writes; the supervisor owns cancellation and exactly-once selection.
const now = performance.now.bind(performance), delay = setTimeout;
export function drainStartupDiagnostic(bytes: Uint8Array, write: (bytes: Uint8Array) => number, active: () => boolean): void | Promise<void> {
  let offset = 0, deadline = now() + 5_000;
  const step = () => {
    while (offset < bytes.length) {
      const fail = (errno: number, reason: string): never => {
        throw new ProcessError(errno, `${reason}; ${bytes.length - offset} of ${bytes.length} startup diagnostic bytes unwritten`);
      };
      if (!active()) fail(ProcessErrno.CANCELED, "startup diagnostic delivery cancelled");
      let written: number;
      try { written = write(bytes.subarray(offset)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        written = fail(error instanceof ProcessError ? error.errno : code === "EPIPE" ? 64 : code === "EBADF" ? ProcessErrno.BADF : 29,
          `startup diagnostic writer threw: ${String(error)}`);
      }
      if (written === -ProcessErrno.AGAIN) {
        if (now() >= deadline) fail(ProcessErrno.AGAIN, "startup diagnostic reader made no progress for five seconds");
        return false;
      }
      if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
        fail(written < 0 ? -written : 29, `startup diagnostic write failed (${written})`);
      }
      offset += written;
      deadline = now() + 5_000;
    }
    return true;
  };
  if (step()) return;
  return (async () => { do { await new Promise(resolve => delay(resolve, 1)); } while (!step()); })();
}
