// ES modules as registration records (crates/bunwasm-runtime/src/js/esm_loader.ts) for an
// EngineHost without a module store: a worker's every ES module, whether or not a service
// worker controls it.
//
// bun-browser.wasm's `hostModuleRecord` prints each ES module's record as a small ES module
// that default-exports it. The host evaluates that as a blob: (data: in Node) module, so the
// record's functions carry a script URL that stack traces map back to the file (WebKit gives
// eval'd code no source locations). That evaluation is asynchronous, so a graph is readied
// first (`prepare`) and then linked and evaluated by the loader in one synchronous pass.
//
// CommonJS, JSON, text and built-in modules become records here, with the browser's native
// wrapper rules (engine-host.js `wrapperSource`): keys taken when the module loads, values
// read when it evaluates, the default handed over separately.

/** The registration record shape `register.rs` prints and the loader links. */
export interface ModuleRecord {
  r: string[];
  i: [number, string][];
  x: [string, number, string][];
  s: number[];
  a: boolean;
  f: (api: { l(getters: Record<string, () => unknown>): void }) => Generator<unknown, void, unknown>;
}

/** What `hostModuleRecord` returns. */
type PreparedRecord = { format: "esm"; record: string } | { format: string; record?: undefined };

/** A non-ES module's exports as `require` produced them, and its separate default. */
interface Handoff {
  value: unknown;
  default: unknown;
}

export interface RecordHost {
  record(key: string): PreparedRecord;
  /** Evaluates a record module's source; its functions' stack frames show `key`. */
  evaluate(code: string, key: string): Promise<ModuleRecord>;
  /** Runs (or reuses) a non-ES module through the runtime's `require` cache. */
  handoff(key: string, format: string): Handoff;
  /** The keys a non-ES module's namespace gets (engine-host.js `wrapperKeys`). */
  keys(value: unknown): string[];
  initMeta(key: string, meta: object): void;
  resolve(specifier: string, referrer: string): string;
  /** False once the process exited. */
  active(): boolean;
  /** Keeps the event loop alive while `operation` is pending. */
  track(operation: Promise<object>): Promise<object>;
}

type LoaderNative = {
  resolve(specifier: string, referrer: string): string;
  load(name: string): { record: ModuleRecord };
  initMeta(name: string, meta: object): void;
  active(): boolean;
  track(operation: Promise<object>): Promise<object>;
  prepare(name: string): Promise<void>;
};

export type LoaderFactory = (native: LoaderNative) => {
  importName(name: string): Promise<object>;
  dynamicImport(specifier: unknown, referrer: string): Promise<object>;
};

export interface ModuleRecords {
  /** Imports the module `key` (a resolved path or built-in name). */
  importKey(key: string): Promise<object>;
  /** `import(specifier)` from `referrer` (CommonJS and eval code). */
  importFrom(specifier: unknown, referrer: string): Promise<object>;
}

const create = Object.create;
const NativeReferenceError = ReferenceError;
const NativeMap = Map;
const NativeSet = Set;
const NativePromise = Promise;
const promiseAll = Promise.all.bind(Promise) as <T>(values: Promise<T>[]) => Promise<T[]>;
const abandoned = <T>(): Promise<T> => new NativePromise<T>(() => {});

/** Creates the process's one record loader. Call before user code runs: `factory` captures built-ins. */
export function createModuleRecords(host: RecordHost, factory: LoaderFactory): ModuleRecords {
  // Each ES module's evaluated record, shared by every graph that reaches it. A failed
  // evaluation is dropped, so a later import tries again, as a native build would.
  // A non-ES module evaluates to its format instead.
  const evaluated = new NativeMap<string, Promise<ModuleRecord | string>>();
  const recordOf = (key: string): Promise<ModuleRecord | string> => {
    const known = evaluated.get(key);
    if (known !== undefined) return known;
    const pending = evaluate(host, key);
    evaluated.set(key, pending);
    pending.then(undefined, () => { if (evaluated.get(key) === pending) evaluated.delete(key); });
    return pending;
  };
  const ready = new NativeMap<string, ModuleRecord | string>();
  const prepare = (key: string) => prepareGraph(host, key, recordOf, ready);
  const loader = factory({
    resolve: (specifier, referrer) => host.resolve(specifier, referrer),
    load: key => {
      const prepared = ready.get(key) ?? host.record(key).format;
      return { record: typeof prepared === "string" ? nonModuleRecord(host, key, prepared) : prepared };
    },
    initMeta: (key, meta) => host.initMeta(key, meta),
    active: () => host.active(),
    track: operation => host.track(operation),
    prepare,
  });
  return {
    importKey: key => prepare(key).then(() => loader.importName(key)),
    importFrom: (specifier, referrer) => loader.dynamicImport(specifier, referrer),
  };
}

async function evaluate(host: RecordHost, key: string): Promise<ModuleRecord | string> {
  const prepared = host.record(key);
  if (prepared.format !== "esm") return prepared.format;
  return host.evaluate(prepared.record!, key);
}

// Evaluates the records of `root` and every ES module it statically imports, level by
// level, sharing records already evaluated. Resolution and parse errors reject here, before
// the loader links anything or runs any CommonJS module. Nothing new starts after exit.
async function prepareGraph(host: RecordHost, root: string, recordOf: (key: string) => Promise<ModuleRecord | string>, ready: Map<string, ModuleRecord | string>): Promise<void> {
  const seen = new NativeSet<string>([root]);
  let level = [root];
  while (level.length > 0) {
    const records = await promiseAll(level.map(recordOf));
    if (!host.active()) return abandoned();
    const next: string[] = [];
    for (let index = 0; index < level.length; index++) addRequests(host, level[index]!, records[index]!, seen, next, ready);
    level = next;
  }
}

function addRequests(host: RecordHost, key: string, record: ModuleRecord | string, seen: Set<string>, next: string[], ready: Map<string, ModuleRecord | string>): void {
  ready.set(key, record);
  if (typeof record === "string") return;
  for (let index = 0; index < record.r.length; index++) {
    const child = host.resolve(record.r[index]!, key);
    if (seen.has(child)) continue;
    seen.add(child);
    next.push(child);
  }
}

// The record of a CommonJS, JSON, text or built-in module, made when the loader loads it
// (as the native path runs it while building the importing graph). Like the native
// wrapper's `const eN = m[key]`, each value is read in key order when the module
// evaluates, and reading one earlier throws.
function nonModuleRecord(host: RecordHost, key: string, format: string): ModuleRecord {
  const handoff = host.handoff(key, format);
  const keys = host.keys(handoff.value);
  const values: unknown[] = [];
  let done = false;
  const binding = (index: number, name: string) => () => {
    if (!done) throw new NativeReferenceError(`Cannot access '${name}' before initialization.`);
    return index < 0 ? handoff.default : values[index];
  };
  const getters: Record<string, () => unknown> = create(null);
  for (let index = 0; index < keys.length; index++) getters[keys[index]!] = binding(index, keys[index]!);
  getters.default = binding(-1, "default");
  const source = handoff.value as Record<string, unknown>;
  return {
    r: [], i: [], x: [], s: [], a: false,
    f: function* (api) {
      api.l(getters);
      yield;
      yield;
      for (let index = 0; index < keys.length; index++) values[index] = source[keys[index]!];
      done = true;
    },
  };
}
