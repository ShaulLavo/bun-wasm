import { attachTerminalOutput } from "../node_modules/waffle/browser/terminal-output";
import type { RunRequest, WorkerMessage } from "../src/bun-executor";

export function terminalOutputFixture(request: RunRequest, dispatch: (message: WorkerMessage) => void) {
  if (!request.terminalOutput) throw new Error("Worker needs its broker-owned terminal output buffer");
  const writer = attachTerminalOutput(request.terminalOutput, {
    checkActive() {}, interrupted: () => false, doorbell() {},
  });
  const flush = () => dispatch({ type: "terminal-output" });
  return {
    write(fd: 1 | 2, bytes: Uint8Array) {
      let accepted = writer.tryWrite(fd, [bytes]);
      if (accepted === -6) { flush(); accepted = writer.tryWrite(fd, [bytes]); }
      if (accepted !== bytes.length) throw new Error(`Fixture output accepted ${accepted}/${bytes.length}`);
    },
    flush,
  };
}
