import { expect, test } from "bun:test";
import { claimOutcome, readOutcome } from "waffle/proc/outcome";
import { createWorkerProcessTransport } from "waffle/proc/worker-client";
import { createNodeProcess, type NodeWasiImports } from "../scripts/node-process.ts";
import { guest } from "../../scripts/fixtures/shared-objects/executor-guest.ts";

test("Node package handoff links and rejects before memory access, preserving fatal cancellation", () => {
  const finishes: Array<{ code: number; signal: number | undefined }> = [];
  const cancelled = new Error("cancelled Node caller");
  const host = createNodeProcess({ transport: createWorkerProcessTransport({ pid: 99 }), postMessage() {},
    finish(code, signal): never { finishes.push({ code, signal }); throw cancelled; } });
  try {
    const imports: NodeWasiImports = { wasi_snapshot_preview1: { fd_close: () => 0, sock_send: () => 52 } };
    host.install(imports, () => { throw new Error("handoff touched guest memory"); });
    const module = guest(0, [{ namespace: "bun_package_scripts", name: "handoff" }]);
    expect(() => new WebAssembly.Instance(module, imports)).not.toThrow();
    const handoff = imports.bun_package_scripts?.handoff;
    if (typeof handoff !== "function") throw new Error("Missing Node handoff import");
    expect(handoff(-1, -1, -1, -1)).toBe(-58);
    expect(finishes).toEqual([]);
    claimOutcome(host.client.signals.outcome, { kind: "signaled", code: 15 });
    expect(() => handoff(-1, -1, -1, -1)).toThrow(cancelled);
    expect(finishes).toEqual([{ code: 143, signal: 15 }]);
    expect(readOutcome(host.client.signals.outcome)).toMatchObject({ kind: "signaled", code: 15 });
  } finally { host.dispose(); }
});
