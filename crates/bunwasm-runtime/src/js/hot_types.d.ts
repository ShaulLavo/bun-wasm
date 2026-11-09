declare namespace BunWasm {
  interface HotDiagnostic {
    path: string;
    original: string;
    record?: string;
    map?: string;
    line1Shift: number;
    lineOffset: number;
  }
  type HotSource = { kind: "builtin"; name: string } | {
    kind: "esm"; path: string; digest: string; identity: string; code: string; diagnostic: HotDiagnostic;
  };
  interface HotGraph {
    readonly id: number;
    readonly sources: Map<string, HotSource>;
    readonly interests: Set<string>;
    readonly inputs: Map<string, string>;
    phase: "candidate" | "committed" | "retired" | "cancelled";
    leases: number;
    releaseDiagnostics(): void;
  }
  type HotFetch = (this: HotServer, request: Request, server: HotServer) => Response | Promise<Response>;
  type HotError = (this: HotServer, error: unknown) => Response | Promise<Response>;
  interface HotServeOptions {
    hostname?: string;
    port?: number | string;
    fetch?: HotFetch;
    error?: HotError;
    routes?: unknown;
    websocket?: unknown;
    tls?: unknown;
    unix?: unknown;
  }
  interface HotServer {
    readonly port: number;
    reload(options: HotServeOptions): HotServer;
    stop(closeActive?: boolean): Promise<void>;
  }
  interface HotCommittedStamp { readonly server: string; readonly revision: number }
  type HotCommitNotice = { readonly kind: "committed"; readonly stamp: HotCommittedStamp } | { readonly kind: "closed" };
  interface HotCommittedRevisions { subscribe(observer: (notice: HotCommitNotice) => void): () => void; }
  interface HotRevisionController {
    readonly source: HotCommittedRevisions;
    stamp(revision: number): HotCommittedStamp;
    commit(stamp: HotCommittedStamp): void;
    close(): void;
  }
  interface HotSnapshot {
    readonly stamp: HotCommittedStamp;
    readonly fetch: HotFetch;
    readonly error: HotError | undefined;
    readonly context: unknown;
    readonly graph: HotGraph;
  }
  interface HotServers {
    serve(options: HotServeOptions, create: (options: HotServeOptions) => HotServer): HotServer;
    begin(graph: HotGraph): void;
    commit(graph: HotGraph): HotServer;
    abort(graph: HotGraph): void;
    select(server: HotServer): Promise<HotSnapshot>;
    release(snapshot: HotSnapshot): void;
    revisions(server: HotServer): HotCommittedRevisions;
    close(server: HotServer): void;
    publish(graph: HotGraph): void;
    dispose(): void;
  }
  interface HotRecordSession {
    importName(name: string): Promise<object>;
    newSession(native: RecordSessionBindings): HotRecordSession;
  }
  interface Native {
    mapPosition(name: string, line: number, column: number): [number, number] | undefined;
    hotMapLookup?: Native["mapPosition"];
    randomBytes(length: number): Uint8Array;
    runMode(): "hot" | "once";
    hotPrepare(generation: number, name: string): HotSource;
    hotDigest(path: string): string;
    hotMapPosition(record: string | undefined, map: string | undefined, shift: number, offset: number, line: number, column: number): [number, number];
    loadPolyfill(name: "esm_loader"): (native: RecordSessionBindings, installHook?: boolean) => HotRecordSession;
  }
  interface Internal {
    mapPosition: Native["mapPosition"];
    getSourceLine(name: string, line: number): string | undefined;
    require(name: "net_hostname"): (hostname: string, brackets?: boolean) => string;
    isBuiltinId(name: string): boolean;
    dirname(path: string): string;
    printError(error: unknown): void;
    require(name: "hot_run"): { run(entry: string): void; dispose(): void };
    require(name: "hot_revisions"): () => HotRevisionController;
    require(name: "hot_serve"): (current: () => HotGraph | undefined) => HotServers;
    hotRun?: { run(entry: string): void; dispose(): void };
    hotServers?: HotServers;
    hotCommitted?: (revision: number, server: HotServer) => void;
    hotDisplayName?(name: string): string | undefined;
    hotFileRequire?(): void;
    builtin(name: "node:fs"): ShellFs;
  }
  interface AsyncHooks {
    AsyncResource: { new(type: string, options?: AsyncResourceOptions): AsyncResource };
    AsyncLocalStorage: new<T>() => { getStore(): T | undefined; run<R>(store: T, callback: () => R): R };
  }
  interface ShellFs {
    statSync(path: string): { ino: number | bigint; dev: number | bigint; isDirectory(): boolean };
    watch(path: string, listener: (kind: string, name: string | null) => void): {
      on(kind: "error", callback: (error: unknown) => void): unknown;
      on(kind: "close", callback: () => void): unknown;
      close(): void;
    };
  }
}
