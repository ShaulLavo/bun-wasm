import type { NotificationWaitSet } from "waffle/browser/notification-wait";

export interface MixedWaitSources {
  readonly set: NotificationWaitSet;
  /** Consumes network news once. Never call again to classify the result. */
  networkReady(): number;
  /** Non-consuming process poll, returning a count or negative WASI errno. */
  processReady(): number;
  checkActive(): void;
}

/** No guest callbacks or pumping on this stack. Coverage belongs to the caller. */
export function waitForIo(sources: MixedWaitSources, timeout: number, now = () => performance.now()): number {
  const deadline = timeout < 0 ? Infinity : now() + timeout;
  for (;;) {
    sources.checkActive();
    if (sources.set.disposed) return 0;
    const sample = sources.set.sample();
    const network = sources.networkReady();
    sources.checkActive();
    if (network !== 0) return network;
    const process = sources.processReady();
    sources.checkActive();
    if (process < 0) return process;
    if (process > 0) return 1;
    // A changed generation can return not-equal forever. Deadline expiry is independent.
    if (now() >= deadline) return 0;
    sources.checkActive();
    const result = sources.set.wait(sample, deadline);
    sources.checkActive();
    if (result === "closed") return 0;
  }
}
