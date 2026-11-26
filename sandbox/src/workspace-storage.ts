import type { Runtime } from "waffle";
import { evictIdle, type EvictionDependencies, type EvictionReport } from "./workspace-eviction";
import { WorkspaceIndex, type ResetState } from "./workspace-index";
import { IDLE_INSTALLS_KEPT, isStorageFull, regenerableOutputs, StorageRecovery } from "./workspace-policy";
import { restoreSource, type RestoreSourceOptions } from "./workspace-restore";
import { templateFiles, templateUrl } from "./template";
import { templates } from "./template-catalog";
import { measureStartup } from "../../web/src/startup";
import { clearInstallCache } from "../../web/src/net/install-cache";

export type StoredWorkspaces = Pick<EvictionDependencies, "stored" | "openIdle">;
type Filesystem = Runtime["filesystem"];
const EVICT_LOCK = "bun-wasm-sandbox-evict";
const templateLockName = (template: string) => `bun-wasm-sandbox-template:${template}`;

export class WorkspaceStorage {
  readonly recovery: StorageRecovery;
  private constructor(
    readonly index: WorkspaceIndex,
    private readonly workspaces: StoredWorkspaces,
    readonly template: string,
    private readonly report: (report: EvictionReport) => void,
  ) {
    this.recovery = new StorageRecovery(async () => { await this.reclaim(0, true); });
  }

  static async open(workspaces: StoredWorkspaces, template: string, report: (report: EvictionReport) => void): Promise<WorkspaceStorage> {
    if (!navigator.locks) throw new Error("Browser storage maintenance needs Web Locks. The workspace was kept.");
    return new WorkspaceStorage(await openIndex(), workspaces, template, report);
  }

  close(): void { this.index.close(); }

  prepare(): Promise<void> { return this.reclaim(IDLE_INSTALLS_KEPT, false); }

  readResetState(): Promise<ResetState> {
    return this.index.readResetState(this.template);
  }

  beginResetTransaction(): Promise<number> {
    return this.index.beginResetTransaction(this.template, Date.now());
  }

  completeResetTransaction(): Promise<void> {
    return this.index.completeResetTransaction(this.template, Date.now());
  }

  initialize(fs: Filesystem, seed: () => Promise<void>, options: RestoreSourceOptions = {}): Promise<void> {
    return this.templateOperation(async () => {
      await restoreSource(fs, this.index, this.template, options);
      await seed();
      await this.index.opened(this.template, Date.now());
    });
  }

  reset(replace: () => Promise<void>): Promise<void> {
    return this.templateOperation(async () => {
      await this.index.reset(this.template, Date.now());
      await replace();
    });
  }

  private templateOperation<T>(action: () => Promise<T>): Promise<T> {
    return navigator.locks.request(templateLockName(this.template), action);
  }

  private async reclaim(kept: number, recovering: boolean): Promise<void> {
    const run = async (lock: Lock | null): Promise<void> => {
      if (!lock) return;
      const started = performance.now();
      let cleared: Promise<boolean> | undefined;
      const clearDownloadCache = () => cleared ??= clearInstallCache();
      const report = await evictIdle(
        { index: this.index, ...this.workspaces, policy: preservationPolicy, clearDownloadCache },
        templates.map(template => template.id),
        this.template,
        kept,
      );
      if (recovering && report.evicted.length === 0) await clearDownloadCache();
      this.report(report);
      measureStartup("storage-reclaim", started, { kept, evicted: report.evicted, protected: report.kept.length, busy: report.busy.length });
    };
    if (!recovering) {
      await navigator.locks.request(EVICT_LOCK, { mode: "exclusive", ifAvailable: true }, run);
      return;
    }
    try {
      await navigator.locks.request(EVICT_LOCK, { mode: "exclusive", signal: AbortSignal.timeout(5_000) }, run);
    } catch (error) {
      if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) return;
      throw error;
    }
  }
}

async function openIndex(): Promise<WorkspaceIndex> {
  try { return await WorkspaceIndex.open(); } catch (error) {
    if (!isStorageFull(error)) throw error;
    await clearInstallCache();
    return WorkspaceIndex.open();
  }
}

async function preservationPolicy(templateId: string): Promise<{ outputs: readonly string[]; templatePaths: ReadonlySet<string> }> {
  const template = templates.find(template => template.id === templateId);
  if (!template) throw new Error("Unknown sandbox template");
  const response = await fetch(templateUrl(template.file));
  if (!response.ok) throw new Error(`${template.file}: HTTP ${response.status}`);
  const files = templateFiles(await response.text());
  if (!files) throw new Error(`${template.file}: invalid project files`);
  return { outputs: regenerableOutputs(template.id), templatePaths: new Set(Object.keys(files)) };
}
