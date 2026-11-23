// Process and page helpers for page-load-profile.ts, kept apart so tests can import them.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface PageLoadState { ready: number | null; error: string | null }

/**
 * A page init script. Readiness comes from the page's own marks, or, for builds that predate
 * them, from when `#status` first said ready. It publishes `__pageLoad.state(app)`, which both
 * the wait and the report read, so they agree on one timestamp.
 */
export function installPageLoadObserver(): void {
  const dom: PageLoadState = { ready: null, error: null };
  const watch = () => {
    const status = document.querySelector<HTMLElement>("#status");
    if (!status) return;
    const text = status.textContent ?? "";
    if (status.dataset.kind === "error") dom.error ??= text;
    if (dom.ready === null && /^(bun\.wasm ready|dev server ready)/.test(text)) dom.ready = performance.now();
  };
  new MutationObserver(watch).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const state = (app: string): PageLoadState => {
    const statuses = performance.getEntriesByName("bunwasm:status") as PerformanceMark[];
    const marked = app === "sandbox"
      ? performance.getEntriesByName("bunwasm:preview")[0]
      : statuses.find(mark => String(mark.detail).startsWith("bun.wasm ready"));
    const ready = marked ? marked.startTime + marked.duration : dom.ready;
    if (ready !== null) return { ready, error: null };
    const last = String(statuses.at(-1)?.detail ?? "");
    return { ready, error: /could not|not in this build|failed|error/i.test(last) ? last : dom.error };
  };
  Object.assign(globalThis, { __pageLoad: { state } });
}

export function requireUniqueNames(names: readonly string[]): void {
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new Error(`Variant ${repeated || "(unnamed)"} is named twice; each needs its own name`);
}

/** Children tracked from the moment they spawn, so teardown reaches one whose start failed. */
export class ChildGroup {
  private readonly children = new Set<ChildProcess>();

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const child = spawn(command, args, options);
    this.children.add(child);
    return child;
  }

  stop(graceMs = 10_000): Promise<void> {
    return Promise.all(Array.from(this.children, child => stopChild(child, graceMs))).then(() => {});
  }
}

/** Stops a child and waits for it to exit; one that ignores SIGTERM past `graceMs` is killed. */
async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

/** Runs `cleanup` once on SIGINT, SIGTERM or SIGHUP, then exits with the signal's status. */
export function onInterrupt(cleanup: () => Promise<void>): void {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
  }
}
