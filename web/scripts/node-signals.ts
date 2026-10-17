import { claimOutcome, outcomeWord, readOutcome } from "waffle/proc/outcome";
import { createSignalState, requestSignal, type SignalTransport } from "waffle/proc/signals";

/** The main Node thread and its root guest share the same signal and terminal-decision words. */
export interface NodeSignalBuffers {
  signalState: SharedArrayBuffer;
  interrupt: SharedArrayBuffer;
  requestedSignal: SharedArrayBuffer;
  outcome: SharedArrayBuffer;
}

export function createNodeSignalController(source?: NodeSignalBuffers | SignalTransport) {
  const buffers = source ?? {
    signalState: new SharedArrayBuffer(65 * 4),
    interrupt: new SharedArrayBuffer(4),
    requestedSignal: new SharedArrayBuffer(4),
    outcome: new SharedArrayBuffer(8),
  };
  const transport = {
    signalState: createSignalState(buffers.signalState),
    interrupt: buffers.interrupt instanceof Int32Array ? buffers.interrupt : new Int32Array(buffers.interrupt),
    requestedSignal: buffers.requestedSignal instanceof Int32Array ? buffers.requestedSignal : new Int32Array(buffers.requestedSignal),
    outcome: outcomeWord(buffers.outcome),
  };
  return {
    buffers,
    request(signal: number) { return requestSignal(transport, signal); },
    finish(code: number, signal?: number) {
      return claimOutcome(transport.outcome, signal === undefined
        ? { kind: "exited", code: code & 0xff }
        : { kind: "signaled", code: signal });
    },
    selected() { return readOutcome(transport.outcome); },
  };
}
