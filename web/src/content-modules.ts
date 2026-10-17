export interface NamedModules {
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

type ModuleUrl = { kind: "content"; url: string } | { kind: "named"; url: string; store: NamedModules };

/** Content URLs avoid service-worker control. Only a cycle needs a URL before its source exists. */
export class ContentModules {
  private urls = new Map<string, ModuleUrl>();
  private building = new Set<string>();
  private options: ModuleOptions;
  private transaction: Map<string, ModuleUrl> | null = null;

  constructor(options: ModuleOptions) { this.options = options; }

  ensure(key: string): string {
    const root = this.transaction === null;
    if (root) this.transaction = new Map();
    try {
      const cached = this.urls.get(key);
      if (cached) return cached.url;
      if (this.building.has(key)) return this.reserve(key);
      this.building.add(key);
      try {
        const source = this.options.source(key);
        const named = this.urls.get(key);
        if (named?.kind === "named") {
          const write = named.store.put(named.url, source);
          if (write) this.options.storing.push(write);
          return named.url;
        }
        const url = this.options.contentUrl(source, key);
        this.set(key, { kind: "content", url });
        return url;
      } finally { this.building.delete(key); }
    } catch (error) {
      if (root) this.rollback();
      throw error;
    } finally {
      if (root) this.transaction = null;
    }
  }

  private set(key: string, module: ModuleUrl): void {
    this.urls.set(key, module);
    this.transaction?.set(key, module);
  }

  private rollback(): void {
    for (const [key, module] of this.transaction ?? []) {
      if (this.urls.get(key) === module) this.urls.delete(key);
      if (this.options.paths.get(module.url) === key) this.options.paths.delete(module.url);
    }
  }

  private reserve(key: string): string {
    if (!this.options.named) throw Object.assign(new Error(`Circular ES module imports are not supported by the browser engine yet (${key})`), { code: "ERR_CIRCULAR_IMPORT" });
    const store = this.options.named;
    const url = store.url(key);
    const module = { kind: "named" as const, url, store };
    this.set(key, module);
    this.options.paths.set(url, key);
    return url;
  }
}
