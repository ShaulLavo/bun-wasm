// Keyboard input for a Bun process started from an interactive terminal. The terminal's owner (the
// shell) puts a Waffle terminal session context and its input buffer in each child's spawn metadata;
// Bun attaches them so that its stdin reads the foreground job's keys. stdout and stderr keep
// Waffle's default host output. Without the metadata, stdin keeps its ordinary end-of-file.
import type { Stream } from "waffle/core/descriptors";
import {
  attachTerminal,
  attachTerminalInput,
  createTerminalInputPolicy,
  terminalControls,
  type TerminalContext,
} from "waffle/browser/runtime-terminals";
import type { RuntimeWorkerRequest } from "waffle/browser/worker";

export interface TerminalMetadata {
  readonly terminalContext: TerminalContext;
  readonly terminalInput: SharedArrayBuffer;
}

export interface BunTerminal {
  /** stdin through the session; undefined keeps Waffle's default stream for stdout and stderr. */
  resolve(target: 0 | 1 | 2): Stream | undefined;
  /** What this process's own children inherit. */
  spawnData(): TerminalMetadata;
  /** Waffle's failure code, or undefined once the session's input mode changed. The shell
   * restores the mode when the job ends. */
  setRawMode(raw: boolean): string | undefined;
  dispose(): void;
}

/** Absent metadata is an ordinary process; partial or malformed metadata fails its start. */
export function attachBunTerminal(request: RuntimeWorkerRequest, checkActive: () => void): BunTerminal | undefined {
  const data = request.runtimeProcess?.data as Partial<Record<keyof TerminalMetadata, unknown>> | undefined;
  if (data?.terminalContext === undefined && data?.terminalInput === undefined) return undefined;
  const process = request.runtimeProcess;
  const input = data.terminalInput;
  if (!process || data.terminalContext === undefined || !(input instanceof SharedArrayBuffer))
    throw new TypeError("Terminal metadata needs both terminalContext and a terminalInput SharedArrayBuffer");
  const policy = createTerminalInputPolicy({ input: attachTerminalInput(input) });
  const attachment = attachTerminal({ context: data.terminalContext, process, checkActive, policy });
  try {
    const ready = attachment.ready();
    if (ready.kind === "error") throw new Error(`Terminal attachment failed: ${ready.code}`);
  } catch (error) {
    attachment.dispose();
    throw error;
  }
  // Each inherited descriptor owns its endpoint (its description closes it); any one of them
  // carries the session's mode controls.
  let stdin: Stream | undefined;
  return {
    resolve: target => target === 0 ? stdin = attachment.resolve(0) : undefined,
    setRawMode(raw) {
      const controls = terminalControls(stdin);
      if (!controls) return "CLOSED";
      const snapshot = controls.snapshot();
      if (snapshot.kind === "error") return snapshot.code;
      const changed = controls.setMode({ expected: snapshot.value.selection, mode: raw ? "raw" : "cooked" });
      return changed.kind === "error" ? changed.code : undefined;
    },
    spawnData: () => ({ terminalContext: attachment.inherit(), terminalInput: input }),
    dispose: () => attachment.dispose(),
  };
}
