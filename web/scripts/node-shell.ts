import { dirname, resolve } from "node:path";
import { pinnedBashWeb, verifiedGuests } from "../../scripts/bash-web-guests.ts";
import { loadNodeProgram } from "./node-linked.ts";
import type { NodeShellModules } from "./node-spawn.ts";

/** Consume the same receipt-backed pair as the browser build, without substituting host tools. */
export async function loadNodeShell(shell?: string, env?: string): Promise<NodeShellModules | undefined> {
  if (shell === undefined && env === undefined) return undefined;
  if (!shell || !env) throw new Error("--shell and --env-utility require the complete receipt-backed pair");
  const directory = dirname(resolve(shell));
  const guests = verifiedGuests(directory, pinnedBashWeb(resolve(import.meta.dirname, "..")));
  if (!guests || guests.find(guest => guest.program === "shell-engine.wasm")?.path !== resolve(shell) ||
      guests.find(guest => guest.program === "env.wasm")?.path !== resolve(env)) {
    throw new Error("--shell and --env-utility must select the receipt-backed bash-web guests in one directory");
  }
  const programs = await Promise.all([loadNodeProgram(shell), loadNodeProgram(env)]);
  if (programs.some(program => program.linkPlan)) throw new Error("bash-web shell and env must be standalone preview1 programs");
  return { shell: programs[0]!.module, env: programs[1]!.module };
}
