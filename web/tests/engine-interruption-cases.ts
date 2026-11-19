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

export type InterruptionEngine = "quickjs" | "jsc" | "spidermonkey";
export const defaultInterruptionEngines: readonly InterruptionEngine[] = ["quickjs", "jsc"];
// SpiderMonkey is experimental and outside the coverage catalogue, so it runs only when selected
// explicitly (--engines=quickjs,jsc,spidermonkey with a staged pair). CI's browser-guest job
// selects it through the ordinary pair its producer bundles (selectBundledInterruptionEngines).
const knownInterruptionEngines: readonly InterruptionEngine[] = ["quickjs", "jsc", "spidermonkey"];

export function selectInterruptionEngines(value?: string): readonly InterruptionEngine[] {
  if (value === undefined) return defaultInterruptionEngines;
  const supplied = value.split(",");
  const selected = knownInterruptionEngines.filter(engine => supplied.includes(engine));
  if (!selected.length || selected.join(",") !== value) throw new Error("Select quickjs, jsc and spidermonkey interruption engines, in that order");
  return selected;
}

/** The coverage-selected paired engines, plus SpiderMonkey when the interruption bundle carries its
 * pair. `required` (CI) turns a missing pair into a failure instead of a silent skip. */
export function selectBundledInterruptionEngines(selected: readonly string[], spiderMonkeyBundled: boolean, required: boolean): readonly InterruptionEngine[] {
  if (required && !spiderMonkeyBundled) throw new Error("BUN_WASM_INTERRUPTION_SPIDERMONKEY=required, but the interruption bundle has no SpiderMonkey pair");
  return selectInterruptionEngines(selected.concat(spiderMonkeyBundled ? ["spidermonkey"] : []).join(","));
}

const engineInputs: Record<InterruptionEngine, readonly string[]> = {
  quickjs: ["bun.wasm", "quickjs.wasm"],
  jsc: ["bun-jsc.wasm", "jsc-engine.wasm"],
  spidermonkey: ["bun-spidermonkey.wasm", "spidermonkey-engine.wasm"],
};

/** The core file each paired engine's page loads; its side is resolved from the core's declaration. */
export function interruptionCore(engine: InterruptionEngine): string { return engineInputs[engine][0]!; }

export function interruptionInputs(engines: readonly InterruptionEngine[]): string[] {
  return ["bun-browser.wasm"].concat(engines.flatMap(engine => engineInputs[engine]));
}

/** Waffle's stop: a page SIGKILL, then Worker.terminate() on a guest spinning in JavaScript. */
export const stopProofName = "runtimeProcess-page-SIGKILL-stops-busy-guest";
/** The same stop while the guest spends its time in the engine's native regexp matcher. */
export const nativeStopProofName = "runtimeProcess-page-SIGKILL-stops-guest-in-native-regexp";
/** The same stop inside one global replace that runs millions of cheap matches. */
export const nativeMatchesStopProofName = "runtimeProcess-page-SIGKILL-stops-guest-in-global-regexp-replace";
/** Both native regexp stop proofs, in the order the busy page runs them. */
export const nativeStopProofNames: readonly string[] = [nativeStopProofName, nativeMatchesStopProofName];
/** Engines that poll for a stop inside their native regexp matcher: QuickJS's lre interrupt check,
 * JSC's Yarr interpreter (every 16,384 backtracks or matches of one pattern) and SpiderMonkey's
 * irregexp (every 8,192 backtracks; its global replace loop is self-hosted JavaScript). */
export const nativePollingEngines: readonly InterruptionEngine[] = ["quickjs", "jsc", "spidermonkey"];

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
    { engine, route: "runtimeProcess", name: stopProofName },
  ].concat(nativePollingEngines.includes(engine) ? nativeStopProofNames.map(name => ({ engine, route: "runtimeProcess", name })) : []));
  return paired.concat([
    { engine: "browser", route: "legacy", name: "default-2-status-130" },
    { engine: "browser", route: "legacy", name: "default-15-status-143" },
    { engine: "browser", route: "runtimeProcess", name: stopProofName },
    { engine: "browser", route: "legacy", name: "legacy-preview1-root-clock-EINTR-dequeue-and-nonsticky-wait" },
    { engine: "browser", route: "legacy", name: "legacy-preview1-child-clock-EINTR-dequeue-and-nonsticky-wait" },
  ]);
}
