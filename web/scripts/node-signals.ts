import { claimOutcome, outcomeWord, readOutcome } from "waffle/proc/outcome";
import { createSignalState, requestSignal, signalPending, type SignalTransport } from "waffle/proc/signals";
const NativeSharedBuffer = SharedArrayBuffer;
const nativeHasInstance = Function.prototype[Symbol.hasInstance];
const nativeApply = Reflect.apply;
function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return nativeApply(nativeHasInstance, NativeSharedBuffer, [value]);
}

/** The main Node thread and its root guest share the same signal and terminal-decision words. */
export interface NodeSignalBuffers {
  signalState: SharedArrayBuffer;
  interrupt: SharedArrayBuffer;
  requestedSignal: SharedArrayBuffer;
  outcome: SharedArrayBuffer;
}

function createSignalBuffers(): NodeSignalBuffers {
  const outcome = outcomeWord().buffer;
  if (!isSharedArrayBuffer(outcome)) throw new TypeError("Node outcome must use shared backing");
  return { signalState: new SharedArrayBuffer(65 * 4), interrupt: new SharedArrayBuffer(4),
    requestedSignal: new SharedArrayBuffer(4), outcome };
}

export function createNodeSignalController(source?: NodeSignalBuffers | SignalTransport) {
  const buffers = source ?? createSignalBuffers();
  const transport = {
    signalState: createSignalState(buffers.signalState),
    interrupt: isSharedArrayBuffer(buffers.interrupt) ? new Int32Array(buffers.interrupt) : buffers.interrupt,
    requestedSignal: isSharedArrayBuffer(buffers.requestedSignal) ? new Int32Array(buffers.requestedSignal) : buffers.requestedSignal,
    outcome: outcomeWord(buffers.outcome),
  };
  return {
    buffers,
    request(signal: number) { return requestSignal(transport, signal); },
    pending() { return signalPending(transport); },
    finish(code: number, signal?: number) {
      return claimOutcome(transport.outcome, signal === undefined
        ? { kind: "exited", code: code & 0xff }
        : { kind: "signaled", code: signal });
    },
    selected() { return readOutcome(transport.outcome); },
  };
}
