import { sharedError } from "./protocol";
import type { SharedObjects, SharedReference } from "./protocol";

interface SharedHostLifetime {
  active(): boolean;
  pending(delta: 1 | -1): void;
  wake(): void;
}
export function bindSharedObjectHost(service: SharedObjects, host: SharedHostLifetime): SharedObjects {
  function active() { if (!host.active()) throw sharedError("Shared-object engine host is closed"); }
  function begin() { active(); return service.begin(); }
  function read(reference: SharedReference) { active(); return service.read(reference); }
  function wait(references: readonly SharedReference[], ready: () => void) {
    active();
    const state: { phase: "preparing" | "pending" | "done" } = { phase: "preparing" };
    function finish(deliver: boolean) {
      if (state.phase === "done") return;
      if (state.phase === "pending") host.pending(-1);
      state.phase = "done";
      if (!host.active()) return;
      try { if (deliver) ready(); } finally { host.wake(); }
    }
    const cancel = service.wait(references, () => finish(true));
    if (!cancel) return null;
    if (state.phase !== "done") { state.phase = "pending"; host.pending(1); }
    return () => { try { cancel(); } finally { finish(false); } };
  }
  return { begin, read, wait };
}
