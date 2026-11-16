// Original harness orchestration: a failed proof does not hide independent cases.
// Cleanup is a separate safety gate, not a proof outcome that can be ignored.
export interface FunctionalCaseIdentity {
  engine: string;
  route: string;
  name: string;
  delivery?: string;
  control?: string;
  trial?: number;
}
export interface FunctionalCaseOutcome extends FunctionalCaseIdentity {
  ok: boolean;
  result?: unknown;
  error?: string;
  context: unknown;
  cleanup: { safe: boolean; error?: string };
}
export class FunctionalCases {
  readonly outcomes: FunctionalCaseOutcome[] = [];
  private unsafe: Error | undefined;
  get ok(): boolean { return this.outcomes.every(outcome => outcome.ok); }
  get safe(): boolean { return !this.unsafe; }
  async run(identity: FunctionalCaseIdentity, run: () => Promise<unknown>, diagnostics: () => unknown, cleanup: () => void | Promise<void>): Promise<FunctionalCaseOutcome> {
    if (this.unsafe) throw this.unsafe;
    const outcome: FunctionalCaseOutcome = { ...identity, ok: false, context: undefined, cleanup: { safe: true } };
    try { outcome.result = await run(); outcome.ok = true; }
    catch (error) { outcome.error = error instanceof Error ? error.stack ?? String(error) : String(error); }
    try { outcome.context = diagnostics(); }
    catch (error) { outcome.context = { diagnosticError: String(error) }; }
    try { await cleanup(); }
    catch (error) {
      outcome.ok = false;
      outcome.cleanup = { safe: false, error: String(error) };
      this.unsafe = new Error(`unsafe functional cleanup (${identity.engine}/${identity.route}/${identity.name}): ${String(error)}`, { cause: error });
    }
    this.outcomes.push(outcome);
    if (this.unsafe) throw this.unsafe;
    return outcome;
  }
}
export async function waitFunctionalCondition(condition: () => boolean, label: string | (() => string), options: {
  completed?: () => boolean;
  aborted?: () => boolean;
  timeoutMs?: number;
  pause?: () => Promise<void>;
  now?: () => number;
} = {}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 2)));
  const end = now() + (options.timeoutMs ?? 15_000);
  while (!condition()) {
    const description = () => typeof label === "function" ? label() : label;
    if (options.completed?.()) throw new Error(`${description()} cannot complete after guest execution finished`);
    if (options.aborted?.() || now() > end) throw new Error(`${description()} timed out`);
    await pause();
  }
}
export function cleanupFunctionalResources(actions: readonly (() => void)[], report: (error: unknown) => void): void {
  for (const action of actions) {
    try { action(); } catch (error) { report(error); }
  }
}
export function assertGuestQuiescence(guests: readonly { evidence: { startEntered: number; startLeft: number; runReturned: number } }[]): void {
  for (const guest of guests) {
    // Production Bun light has no _start observer, so a failed light proof cannot
    // establish quiescence here. Its logical exit or terminate call is not enough.
    const stopped = guest.evidence.startEntered === 1 && guest.evidence.startLeft === 1 && guest.evidence.runReturned === 1;
    if (!stopped) throw new Error(`guest execution quiescence is unproved after failed case: ${JSON.stringify(guest.evidence)}`);
  }
}

export type InterruptionEngine = "quickjs" | "jsc";
export const defaultInterruptionEngines: readonly InterruptionEngine[] = ["quickjs", "jsc"];

export function selectInterruptionEngines(value?: string): readonly InterruptionEngine[] {
  if (value === undefined) return defaultInterruptionEngines;
  const supplied = value.split(",");
  const selected = defaultInterruptionEngines.filter(engine => supplied.includes(engine));
  if (!selected.length || selected.join(",") !== value) throw new Error("Select quickjs, jsc or quickjs,jsc interruption engines");
  return selected;
}

export function interruptionInputs(engines: readonly InterruptionEngine[]): string[] {
  return ["bun-browser.wasm"].concat(engines.flatMap(engine => engine === "quickjs"
    ? ["bun.wasm", "quickjs.wasm"] : ["bun-jsc.wasm", "jsc-engine.wasm"]));
}

export function interruptionProofs(engines: readonly InterruptionEngine[]) {
  const paired: { engine: string; route: string; name: string }[] = engines.flatMap(engine => [
    { engine, route: "legacy", name: "default-2-status-130" },
    { engine, route: "legacy", name: "default-15-status-143" },
    { engine, route: "legacy", name: "native-interrupt-true-unwinds-current-frame" },
    { engine, route: "legacy", name: "handled-SIGINT-queued-until-yield-and-exits-23" },
    { engine, route: "legacy", name: "nested-SIGINT-handler-default-15-status-143" },
    { engine, route: "legacy", name: "idle-handled-SIGINT-notifies-blocked-generation-and-exits-23" },
    { engine, route: "legacy", name: "legacy-page-kill-and-killJob-idle-handled-SIGINT-notifies-blocked-generation-and-exits-23" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-default-2-status-130" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-default-15-status-143" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-handled-SIGINT-queued-until-yield-and-exits-23" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-nested-SIGINT-handler-default-15-status-143" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-kill-and-killJob-idle-handled-SIGINT-notifies-blocked-generation-and-exits-23" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-sleepSync-SIGUSR1-deferred-handler" },
    { engine, route: "runtimeProcess", name: "runtimeProcess-page-sleepSync-default-SIGUSR1-unwinds" },
  ]);
  return paired.concat([
    { engine: "browser", route: "legacy", name: "default-2-status-130" },
    { engine: "browser", route: "legacy", name: "default-15-status-143" },
    { engine: "browser", route: "legacy", name: "legacy-preview1-root-clock-EINTR-dequeue-and-nonsticky-wait" },
    { engine: "browser", route: "legacy", name: "legacy-preview1-child-clock-EINTR-dequeue-and-nonsticky-wait" },
  ]);
}
