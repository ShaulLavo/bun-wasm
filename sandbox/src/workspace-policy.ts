import type { WorkspaceRecord } from "./workspace-index";

export const IDLE_INSTALLS_KEPT = 1;
export const workspaceName = (template: string): string => `bun-wasm-sandbox-${template}`;

/** These paths belong to the shipped framework, never to an edited package manifest. */
const frameworkOutputs: Readonly<Record<string, readonly string[]>> = {
  next: [".next"],
  "next-app": [".next"],
  nuxt: [".nuxt", ".output"],
  sveltekit: [".svelte-kit"],
  astro: [".astro"],
  angular: [".angular"],
  solidstart: [".vinxi", ".output"],
  "tanstack-start": [".tanstack"],
  "react-router": [".react-router"],
};

export function regenerableOutputs(template: string): readonly string[] { return frameworkOutputs[template] ?? []; }

export function evictionOrder(records: readonly WorkspaceRecord[], stored: readonly string[], catalog: readonly string[], current: string): string[] {
  const present = new Set(stored);
  const opened = new Map(records.map(record => [record.template, record.lastOpened]));
  return catalog.filter(template => template !== current && present.has(workspaceName(template)))
    .sort((a, b) => (opened.get(a) ?? 0) - (opened.get(b) ?? 0) || a.localeCompare(b));
}

export function isStorageFull(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (storageMessage(current)) return true;
    current = current && typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return false;
}

function storageMessage(value: unknown): boolean {
  if (typeof value === "string") return /QuotaExceededError|ENOSPC|errno\s+51\b|no space left on device/i.test(value);
  if (!value || typeof value !== "object") return false;
  return "name" in value && value.name === "QuotaExceededError"
    || "message" in value && typeof value.message === "string" && storageMessage(value.message)
    || "errno" in value && value.errno === 51;
}

/** All callers retry their own failed operation after this one shared reclaim completes. */
export class StorageRecovery {
  private active?: Promise<void>;
  constructor(private readonly reclaim: () => Promise<void>) {}

  recover(error: unknown): Promise<void> {
    if (!isStorageFull(error)) return Promise.reject(error);
    if (this.active) return this.active;
    const current = this.reclaim().finally(() => { if (this.active === current) this.active = undefined; });
    this.active = current;
    return current;
  }

  async retry<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { await this.recover(error); }
    return operation();
  }
}
