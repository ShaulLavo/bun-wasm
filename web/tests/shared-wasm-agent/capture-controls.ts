import type { WorkerExecutor, WorkerSetupContext } from "waffle/browser/worker";
import type { CapturedRequest, CaptureWriter } from "./capture";

/** Executed in the selected engine's real worker, before that control's guest starts. */
export function qualifyCapture(executor: WorkerExecutor<CapturedRequest>, capture: CaptureWriter): WorkerExecutor<CapturedRequest> {
  const original = new RangeError("member capture caught RangeError control");
  try { capture.run("control.caught-range-error", () => { throw original; }); }
  catch (error) { if (error !== original) throw new Error("Capture replaced the original RangeError"); }
  const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 116, 114, 97, 112, 0, 0, 10, 5, 1, 3, 0, 0, 11]));
  const trap = new WebAssembly.Instance(module).exports.trap;
  if (typeof trap !== "function") throw new Error("Missing capture control trap");
  try { capture.run("control.wasm-trap", () => trap()); }
  catch (error) { if (!(error instanceof WebAssembly.RuntimeError)) throw error; }
  self.dispatchEvent(new ErrorEvent("error", { error: new RangeError("member capture worker event control") }));
  let post: WorkerSetupContext["post"] | undefined;
  return {
    ...executor,
    namespaces(context) { post = context.post; return executor.namespaces?.(context) ?? {}; },
    initialize(context) {
      if (!post?.("stderr", new TextEncoder().encode("member capture host stderr control\n"))) throw new Error("Capture control host write was not accepted");
      executor.initialize?.(context);
    },
    beforeFinish() {
      executor.beforeFinish?.();
      throw new Error("member capture cleanup failure control");
    },
  };
}
