import { inheritedFilesystemControl, webIdlBoundaryControl } from "./worker-bootstrap-control.js";

void (async () => {
  try {
    if (!crossOriginIsolated) throw new Error("bootstrap control requires cross-origin isolation");
    const filesystem = await inheritedFilesystemControl();
    Reflect.set(globalThis, "workerBootstrapResult", { ok: true, filesystem, webIdl: webIdlBoundaryControl(), pending: [
      "partial binding rollback: Waffle #23",
      "complete child diagnostic delivery: Waffle child-diagnostics fix",
      "same-realm Atomics/shared-view tampering: Waffle intrinsic-capture fix",
    ] });
  } catch (error) { Reflect.set(globalThis, "workerBootstrapResult", { ok: false, error: String(error) }); }
})();
