import type { WorkspaceIndexStore } from "./workspace-index";
import { evictionOrder, isStorageFull, workspaceName } from "./workspace-policy";
import { excludedRoots, readSource, type SourceReader, type SourceSnapshot } from "./workspace-source";

interface IdleSource extends SourceReader {
  delete(): Promise<void>;
  close(): Promise<void>;
}

export interface EvictionDependencies {
  readonly index: WorkspaceIndexStore;
  readonly stored: () => Promise<string[]>;
  readonly openIdle: (name: string, signal?: AbortSignal) => Promise<IdleSource | "busy" | "missing">;
  readonly policy: (template: string) => Promise<{ outputs: readonly string[]; templatePaths: ReadonlySet<string> }>;
  readonly clearDownloadCache: () => Promise<boolean>;
}

export interface EvictionReport {
  readonly evicted: string[];
  readonly busy: string[];
  readonly kept: { readonly template: string; readonly error: unknown }[];
}

/** Caller holds the sandbox origin operation lock through this entire fresh pass. */
export async function evictIdle(deps: EvictionDependencies, catalog: readonly string[], current: string, kept: number, signal?: AbortSignal): Promise<EvictionReport> {
  const report: EvictionReport = { evicted: [], busy: [], kept: [] };
  const candidates = evictionOrder(await deps.index.records(), await deps.stored(), catalog, current);
  const protectedTemplates = await newestIdle(deps, candidates, kept, report, signal);
  let cacheCleared = false;
  const preserve = async (snapshot: SourceSnapshot): Promise<void> => {
    try { await deps.index.preserve(snapshot); } catch (error) {
      if (!isStorageFull(error) || cacheCleared) throw error;
      cacheCleared = true;
      await deps.clearDownloadCache();
      await deps.index.preserve(snapshot);
    }
  };
  for (const template of candidates) {
    signal?.throwIfAborted();
    if (protectedTemplates.has(template)) continue;
    await evictOne(deps, template, preserve, report, signal);
  }
  return report;
}

async function newestIdle(deps: EvictionDependencies, candidates: readonly string[], kept: number, report: EvictionReport, signal?: AbortSignal): Promise<Set<string>> {
  const protectedTemplates = new Set<string>();
  for (const template of candidates.toReversed()) {
    if (protectedTemplates.size >= kept) break;
    signal?.throwIfAborted();
    try {
      const handle = await deps.openIdle(workspaceName(template), signal);
      if (typeof handle === "string") continue;
      try { protectedTemplates.add(template); } finally { await handle.close(); }
    } catch (error) { report.kept.push({ template, error }); }
  }
  return protectedTemplates;
}

async function evictOne(deps: EvictionDependencies, template: string, preserve: (snapshot: SourceSnapshot) => Promise<void>, report: EvictionReport, signal?: AbortSignal): Promise<void> {
  try {
    const handle = await deps.openIdle(workspaceName(template), signal);
    if (handle === "busy") { report.busy.push(template); return; }
    if (handle === "missing") return;
    try { await preserveAndDelete(deps, handle, template, preserve, signal); } finally { await handle.close(); }
    report.evicted.push(template);
  } catch (error) {
    if (signal?.aborted) throw error;
    report.kept.push({ template, error });
  }
}

async function preserveAndDelete(deps: EvictionDependencies, handle: IdleSource, template: string, preserve: (snapshot: SourceSnapshot) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const policy = await deps.policy(template);
  const snapshot = await readSource(handle, template, excludedRoots(policy.outputs, policy.templatePaths), signal);
  await preserve(snapshot);
  signal?.throwIfAborted();
  await handle.delete();
}
