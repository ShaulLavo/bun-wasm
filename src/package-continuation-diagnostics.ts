import { Signal, type ProcessExit } from "waffle/proc/types";
import type { PackagePhase, PackagePlan } from "./package-continuation-plan.js";

// Same WASI-to-Node conversion as spawn.ts::processError, including its unmapped E32.
const errors: Readonly<Record<number, readonly [string, number | undefined]>> = {
  1: ["E2BIG", -7], 2: ["EACCES", -13], 6: ["EAGAIN", -11], 8: ["EBADF", -9], 12: ["ECHILD", -10],
  21: ["EFAULT", -14], 27: ["EINTR", -4], 28: ["EINVAL", -22], 29: ["EIO", -5], 33: ["EMFILE", -24],
  44: ["ENOENT", -2], 45: ["ENOEXEC", -8], 48: ["ENOMEM", -12], 52: ["ENOSYS", -38], 54: ["ENOTDIR", -20],
  58: ["ENOTSUP", -95], 63: ["EPERM", -1], 64: ["EPIPE", -32], 71: ["ESRCH", -3], 76: ["ENOTCAPABLE", undefined],
};

export function announcement(plan: PackagePlan, phase: PackagePhase): string {
  if (plan.silent) return "";
  return plan.color ? `\x1b[0m\x1b[2m\x1b[35m$\x1b[0m \x1b[2m\x1b[1m${phase.command}\x1b[0m\n` : `$ ${phase.command}\n`;
}

export function scriptDiagnostic(plan: PackagePlan, phase: PackagePhase, exit: ProcessExit): string {
  if (plan.silent) return "";
  switch (exit.kind) {
    case "exited": return exit.code === 0 || exit.code === 2 ? "" : `error: script "${phase.name}" exited with code ${exit.code}\n`;
    case "signaled": {
      const name = signalName(exit.code);
      return exit.code === 2 ? "" : `error: script "${phase.name}" was terminated by signal ${name}\n`;
    }
    case "start-failed": return "";
    default: { const exhaustive: never = exit; return exhaustive; }
  }
}

function signalName(code: number): string | number {
  return Object.entries(Signal).find(entry => entry[1] === code)?.[0] ?? code;
}

/** Restricted to spawn.ts's plain Error fields, whose internal stack inspect hides. */
export function startupDiagnostic(executable: string, wasi: number, diagnostic: string, footer: string): string {
  const [code, errno] = errors[wasi] ?? [`E${wasi}`, undefined];
  const message = `spawn ${executable} ${code}` + (diagnostic ? `: ${diagnostic}` : "");
  return `error: ${message}\n   errno: ${errno},\n syscall: "spawn",\n    path: ${JSON.stringify(executable)},\n    code: ${JSON.stringify(code)}\n\n\n${footer}`;
}
