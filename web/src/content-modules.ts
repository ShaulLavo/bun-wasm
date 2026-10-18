interface NamedModules {
  url(key: string): string;
  put(url: string, source: string): void | Promise<unknown>;
}

interface ModuleOptions {
  named?: NamedModules;
  source(key: string): string;
  contentUrl(source: string, key: string): string;
  paths: Map<string, string>;
  storing: Promise<unknown>[];
}

type ModuleUrl = { kind: "content"; url: string } | { kind: "named"; url: string; store: NamedModules; ready: boolean };

/** Content URLs avoid service-worker control. Only a cycle needs a URL before its source exists. */
export class ContentModules {
  private urls = new Map<string, ModuleUrl>();
  private building = new Set<string>();
  private pending = new Set<string>();
  private dependencies = new Map<string, Set<string>>();
  private sourceKey: string | undefined;
  private options: ModuleOptions;

  constructor(options: ModuleOptions) { this.options = options; }

  ensure(key: string): string {
    const parent = this.sourceKey;
    const url = this.build(key);
    if (parent !== undefined) this.dependencies.get(parent)?.add(key);
    return url;
  }

  private repairReservations(key: string): void {
      if (this.pending.size > 0) {
        this.building.add(key);
        try {
          for (const dependency of this.dependencies.get(key) ?? []) this.build(dependency);
        } finally { this.building.delete(key); }
      }
  }

  private build(key: string): string {
    const cached = this.urls.get(key);
    if (cached && this.building.has(key)) return cached.url;
    if (cached && (cached.kind === "content" || cached.ready)) {
      // A cached child can point back to a source build that failed. Repair reachable
      // reservations before returning it, even when the caller retries through the child.
      this.repairReservations(key);
      return cached.url;
    }
    if (this.building.has(key)) return this.reserve(key);
    this.building.add(key);
    this.dependencies.set(key, new Set());
    const parent = this.sourceKey;
    this.sourceKey = key;
    try {
      const source = this.options.source(key);
      const named = this.urls.get(key);
      if (named?.kind === "named") {
        const write = named.store.put(named.url, source);
        if (write) this.options.storing.push(write);
        named.ready = true;
        this.pending.delete(key);
        return named.url;
      }
      const url = this.options.contentUrl(source, key);
      this.urls.set(key, { kind: "content", url });
      return url;
    } finally {
      // A failed source build keeps its unfinished reservation: cached children may already
      // reference it. Retrying rebuilds the source at that same URL instead of stranding them.
      this.sourceKey = parent;
      this.building.delete(key);
    }
  }

  private reserve(key: string): string {
    if (!this.options.named) throw Object.assign(new Error(`Circular ES module imports are not supported by the browser engine yet (${key})`), { code: "ERR_CIRCULAR_IMPORT" });
    const store = this.options.named;
    const url = store.url(key);
    this.urls.set(key, { kind: "named", url, store, ready: false });
    this.pending.add(key);
    this.options.paths.set(url, key);
    return url;
  }
}
