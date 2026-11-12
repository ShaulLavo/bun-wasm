import { bytes } from "waffle";
import { PipePublicationRegistry } from "waffle/proc/pipes";
import { workerProcessState, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { fixtureReservations } from "../../tests/helpers/process-reservations.ts";

/** Real control admission for isolated bootstrap tests, without inventing a worker grant. */
export async function workerControlFixture() {
  const owner = fixtureReservations();
  try {
    const reservations = await owner.ready;
    const ticket = reservations.admit({ pid: 0, executable: "worker bootstrap fixture", guest: { kind: "undeclared" }, group: "none", connection: false, controls: true });
    const launched = ticket.launched();
    let stopped = false;
    return {
      grant: ticket.control,
      attach(transport: WorkerProcessTransport | undefined): void {
        if (!transport) return;
        const registry = new PipePublicationRegistry({ allocate: (length, maximum) => reservations.buffer("pipe-registry", { kind: "growable-buffer", initial: length, maximum: bytes(maximum) }) });
        registry.registerProcess(workerProcessState(transport).pid);
        const data = transport.data;
        transport.data = { ...(data && typeof data === "object" ? data : {}), pipeRegistry: registry.handle() };
      },
      allocated: (buffer: SharedArrayBuffer) => launched.controlAllocated(buffer),
      async dispose() {
        if (stopped) return;
        stopped = true;
        launched.stopped();
        await owner.dispose();
      },
    };
  } catch (error) { await owner.dispose(); throw error; }
}
