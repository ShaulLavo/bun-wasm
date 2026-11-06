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
//
// Like the loader, this captures every built-in operation it uses when the process's loader
// is created (after the host wraps promise reactions, before user code), so user changes to
// globals and prototypes never reach module loading. Its promises settle with `undefined`
// through captured reactions (records travel beside them), so no user-visible `then` is
// looked up. Once the host is inactive (the process exited) it makes no new native call and
// settles nothing.

/** The registration record shape `register.rs` prints and the loader links. */
export interface ModuleRecord {
  r: string[];
  i: [number, string][];
  x: [string, number, string][];
  s: number[];
  /** Local exports: [export name, local binding]. */
  e: [string, string][];
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

/** Promise reactions as the host captured them. */
export type Then = <T>(promise: Promise<T>, onFulfilled: (value: T) => void, onRejected: (error: unknown) => void) => unknown;

export interface RecordHost {
  record(key: string): PreparedRecord;
  /** Evaluates a record module's source, whose functions' stack frames show `key`, and passes the record to `done`. */
  evaluate(code: string, key: string, done: (record: ModuleRecord) => void, fail: (error: unknown) => void): void;
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

const { create, defineProperty } = Object;
const NativeReferenceError = ReferenceError;
const NativeMap = Map;
const NativeSet = Set;
const NativePromise = Promise;
const call = Function.prototype.call;
const uncurry = <A extends unknown[], R>(method: (...args: A) => R) => call.bind(method) as unknown as (self: unknown, ...args: A) => R;
const mapGet = uncurry(Map.prototype.get) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
const mapSet = uncurry(Map.prototype.set) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
const mapDelete = uncurry(Map.prototype.delete) as <K, V>(map: Map<K, V>, key: K) => boolean;
const setHas = uncurry(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const setAdd = uncurry(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const arrayPush = uncurry(Array.prototype.push) as <T>(array: T[], item: T) => number;
const abandoned = <T>(): Promise<T> => new NativePromise<T>(() => {});

/** A module's evaluated record (or a non-ES module's format), once `settled` fulfils. */
type Entry = { settled: Promise<void>; value: ModuleRecord | string | undefined };

/** Creates the process's one record loader. Call before user code runs, after the host wraps promise reactions: `then` and `factory` capture built-ins. */
export function createModuleRecords(host: RecordHost, factory: LoaderFactory, then: Then): ModuleRecords {
  // Each ES module's evaluated record, shared by every graph that reaches it. A failed
  // evaluation is dropped, so a later import tries again, as a native build would.
  const evaluated = new NativeMap<string, Entry>();
  const entryOf = (key: string): Entry => {
    const known = mapGet(evaluated, key);
    if (known !== undefined) return known;
    const entry: Entry = { settled: abandoned(), value: undefined };
    entry.settled = evaluate(host, key, entry);
    mapSet(evaluated, key, entry);
    then(entry.settled, () => {}, () => { if (mapGet(evaluated, key) === entry) mapDelete(evaluated, key); });
    return entry;
  };
  const ready = new NativeMap<string, ModuleRecord | string>();
  const prepare = (key: string) => prepareGraph(host, key, entryOf, ready, then);
  const loader = factory({
    resolve: (specifier, referrer) => host.resolve(specifier, referrer),
    load: key => {
      const prepared = mapGet(ready, key) ?? host.record(key).format;
      return { record: typeof prepared === "string" ? nonModuleRecord(host, key, prepared) : prepared };
    },
    initMeta: (key, meta) => host.initMeta(key, meta),
    active: () => host.active(),
    track: operation => host.track(operation),
    prepare,
  });
  const importKey = (key: string): Promise<object> => new NativePromise<object>((resolve, reject) => {
    if (!host.active()) return;
    then(prepare(key), () => { then(loader.importName(key), resolve, reject); }, reject);
  });
  return {
    importKey,
    importFrom: (specifier, referrer) => loader.dynamicImport(specifier, referrer),
  };
}

// Fills `entry` with the module's record or, for a non-ES module, its format. Nothing
// native runs after exit, and nothing settles.
function evaluate(host: RecordHost, key: string, entry: Entry): Promise<void> {
  return new NativePromise<void>((resolve, reject) => {
    if (!host.active()) return;
    const prepared = host.record(key);
    if (prepared.format !== "esm") {
      entry.value = prepared.format;
      resolve();
      return;
    }
    host.evaluate(prepared.record!, key, record => {
      entry.value = record;
      if (host.active()) resolve();
    }, error => {
      if (host.active()) reject(error);
    });
  });
}

// Evaluates the records of `root` and every ES module it statically imports, level by
// level, sharing records already evaluated. Resolution and parse errors reject here, before
// the loader links anything or runs any CommonJS module.
function prepareGraph(host: RecordHost, root: string, entryOf: (key: string) => Entry, ready: Map<string, ModuleRecord | string>, then: Then): Promise<void> {
  return new NativePromise<void>((resolve, reject) => {
    // Filled with the captured `add`: the constructor would look `add` up on the prototype.
    const seen = new NativeSet<string>();
    setAdd(seen, root);
    const level = (keys: string[]) => {
      if (!host.active()) return;
      if (keys.length === 0) {
        resolve();
        return;
      }
      const entries: Entry[] = [];
      for (let index = 0; index < keys.length; index++) arrayPush(entries, entryOf(keys[index]!));
      all(entries, then, () => {
        if (!host.active()) return;
        const next: string[] = [];
        try {
          for (let index = 0; index < keys.length; index++) addRequests(host, keys[index]!, entries[index]!.value!, seen, next, ready);
        } catch (error) {
          reject(error);
          return;
        }
        level(next);
      }, error => {
        if (host.active()) reject(error);
      });
    };
    level([root]);
  });
}

// Calls `done` once every entry settled, or `fail` with the first rejection.
function all(entries: Entry[], then: Then, done: () => void, fail: (error: unknown) => void): void {
  let remaining = entries.length;
  let failed = false;
  for (let index = 0; index < entries.length; index++) {
    then(entries[index]!.settled, () => {
      remaining -= 1;
      if (remaining === 0 && !failed) done();
    }, error => {
      if (failed) return;
      failed = true;
      fail(error);
    });
  }
}

function addRequests(host: RecordHost, key: string, record: ModuleRecord | string, seen: Set<string>, next: string[], ready: Map<string, ModuleRecord | string>): void {
  mapSet(ready, key, record);
  if (typeof record === "string") return;
  for (let index = 0; index < record.r.length; index++) {
    const child = host.resolve(record.r[index]!, key);
    if (setHas(seen, child)) continue;
    setAdd(seen, child);
    arrayPush(next, child);
  }
}

// The record of a CommonJS, JSON, text or built-in module, made when the loader loads it
// (as the native path runs it while building the importing graph). Like the native
// wrapper's `const eN = m[key]`, each value is read in key order when the module
// evaluates, and reading one earlier throws. Every key, `__proto__` included, is an own
// local of its own.
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
  const exports: [string, string][] = [];
  const local = (name: string, getter: () => unknown) => {
    defineProperty(getters, name, { __proto__: null, value: getter, enumerable: true } as PropertyDescriptor);
    arrayPush(exports, [name, name]);
  };
  for (let index = 0; index < keys.length; index++) local(keys[index]!, binding(index, keys[index]!));
  local("default", binding(-1, "default"));
  const source = handoff.value as Record<string, unknown>;
  return {
    r: [], i: [], x: [], s: [], e: exports, a: false,
    f: function* (api) {
      api.l(getters);
      yield;
      yield;
      for (let index = 0; index < keys.length; index++) values[index] = source[keys[index]!];
      done = true;
    },
  };
}
