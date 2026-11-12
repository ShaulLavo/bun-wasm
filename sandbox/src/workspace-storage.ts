import type { Runtime } from "waffle";
import { evictIdle, type EvictionDependencies, type EvictionReport } from "./workspace-eviction";
import { WorkspaceIndex } from "./workspace-index";
import { IDLE_INSTALLS_KEPT, regenerableOutputs, StorageRecovery } from "./workspace-policy";
import { restoreSource } from "./workspace-restore";
import { templateFiles } from "./template";
import { templates } from "./template-catalog";

export type StoredWorkspaces = Pick<EvictionDependencies, "stored" | "openIdle">;
type Filesystem = Runtime["filesystem"];
const OPERATION_LOCK = "bun-wasm-sandbox-storage";
const DOWNLOAD_CACHE = "bun-wasm-install-v1";

export class WorkspaceStorage {
  readonly recovery: StorageRecovery;
  private constructor(private readonly index: WorkspaceIndex, private readonly workspaces: StoredWorkspaces, readonly template: string, private readonly report: (report: EvictionReport) => void) {
    this.recovery = new StorageRecovery(async () => { await this.reclaim(0, true); });
  }

  static async open(workspaces: StoredWorkspaces, template: string, report: (report: EvictionReport) => void): Promise<WorkspaceStorage> {
    if (!navigator.locks) throw new Error("Browser storage maintenance needs Web Locks. The workspace was kept.");
    return new WorkspaceStorage(await WorkspaceIndex.open(), workspaces, template, report);
  }

  close(): void { this.index.close(); }

  prepare(): Promise<void> { return this.reclaim(IDLE_INSTALLS_KEPT, false); }

  restore(fs: Filesystem): Promise<void> {
    return this.operation(async () => {
      await restoreSource(fs, this.index, this.template);
      await this.index.opened(this.template, Date.now());
    });
  }

  reset(replace: () => Promise<void>): Promise<void> {
    return this.operation(async () => {
      await this.index.reset(this.template, Date.now());
      await replace();
    });
  }

  private operation<T>(action: () => Promise<T>): Promise<T> {
    return navigator.locks.request(OPERATION_LOCK, action);
  }

  private reclaim(kept: number, recovering: boolean): Promise<void> {
    return this.operation(async () => {
      let cleared: Promise<boolean> | undefined;
      const clearDownloadCache = () => cleared ??= caches.delete(DOWNLOAD_CACHE);
      const report = await evictIdle({ index: this.index, ...this.workspaces, policy: preservationPolicy, clearDownloadCache }, templates.map(template => template.id), this.template, kept);
      if (recovering && report.evicted.length === 0) await clearDownloadCache();
      this.report(report);
    });
  }
}

async function preservationPolicy(templateId: string): Promise<{ outputs: readonly string[]; templatePaths: ReadonlySet<string> }> {
  const template = templates.find(template => template.id === templateId);
  if (!template) throw new Error("Unknown sandbox template");
  const response = await fetch(`./${template.file}`);
  if (!response.ok) throw new Error(`${template.file}: HTTP ${response.status}`);
  const files = templateFiles(await response.text());
  if (!files) throw new Error(`${template.file}: invalid project files`);
  return { outputs: regenerableOutputs(template.id), templatePaths: new Set(Object.keys(files)) };
}
