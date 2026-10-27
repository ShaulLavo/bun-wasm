import { sharedError, sharedRouteCommand } from "./protocol.ts";
import type { SharedObjects, SharedReference } from "./protocol.ts";

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
  const routes = service.routes;
  if (!routes) return { begin, read, wait, mailbox: service.mailbox };
  active();
  routes.enable();
  const mailbox = service.mailbox;
  return {
    begin,
    read,
    wait,
    mailbox: mailbox ? {
      buffer: mailbox.buffer,
      capacity: mailbox.capacity,
      reserve(bytes) { active(); return mailbox.reserve(bytes); },
      write(bytes) { active(); return mailbox.write(bytes); },
      drain(consume) { if (!host.active()) return 0; return mailbox.drain(consume); },
      close: () => mailbox.close(),
      inspect: () => mailbox.inspect(),
    } : undefined,
    routes: {
      owner: routes.owner,
      get enabled() { return routes.enabled; },
      enable() { active(); routes.enable(); host.wake(); },
      send(command) {
        const parsed = sharedRouteCommand(command);
        if (!host.active() && (parsed.kind === "closed" || parsed.kind === "port-close")) return true;
        active(); const accepted = routes.send(parsed); if (accepted) host.wake(); return accepted;
      },
      transaction(deliver, commit) { active(); routes.transaction(deliver, commit); host.wake(); },
      credit() { if (!host.active()) return; routes.credit(); host.wake(); },
    },
  };
}
