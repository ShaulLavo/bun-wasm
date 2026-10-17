(function (internal: BunWasm.Internal) {
  "use strict";
  type Wire = number | bigint | null;
  type Signature = BunWasm.WasmSignature;
  type Description = BunWasm.WasmDescription;
  interface MemoryRecord { id: number; name: string; buffer: ArrayBuffer; generation?: bigint; }
  interface State { id: number; memories: MemoryRecord[]; memoryObjects: Map<number, Memory>; }
  interface TableRecord { id: number; type: string; }
  const native = internal.native.wasm;
  const modules = new WeakMap<Module, Description>();
  const memories = new WeakMap<Memory, MemoryRecord>();
  const globals = new WeakMap<Global, { id: number; name: string; type: string; mutable: boolean }>();
  const tables = new WeakMap<Table, TableRecord>();
  const tableObjects = new Map<number, Table>();
  const functionIds = new WeakMap<Function, number>();
  const functionObjects = new Map<number, Function>();
  const references: unknown[] = [];
  const referenceIds = new Map<unknown, number>();
  const imports: { callback: Function; params: string[]; results: string[] }[] = [];
  const states: State[] = [];
  const memoryBuffers = new WeakSet<ArrayBuffer>();
  internal.isWasmMemoryBuffer = value => value instanceof ArrayBuffer && memoryBuffers.has(value);
  class CompileError extends Error { constructor(message: string) { super(message); this.name = "CompileError"; } }
  class LinkError extends Error { constructor(message: string) { super(message); this.name = "LinkError"; } }
  class RuntimeError extends Error { constructor(message: string) { super(message); this.name = "RuntimeError"; } }
  function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  function snapshot(source: unknown) {
    // JSC pins buffers passed through its C API. Native calls must own their snapshots.
    if (source instanceof ArrayBuffer) return new Uint8Array(source).slice();
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
    throw new TypeError("Expected a WebAssembly BufferSource");
  }
  function index(value: unknown): number {
    const number = Math.trunc(+(value as number));
    if (!Number.isFinite(number) || number < 0 || Math.trunc(number) > 0xffffffff) throw new TypeError("Invalid WebAssembly index");
    return Math.trunc(number);
  }
  class Module {
    constructor(source: unknown) {
      const input = snapshot(source);
      try { modules.set(this, native.compile(input)); }
      catch (error) { throw new CompileError(message(error)); }
    }
    static imports(module: Module) {
      const description = modules.get(module);
      if (!description) throw new TypeError("Expected a WebAssembly.Module");
      return description.imports.map(({ module, name, kind }) => ({ module, name, kind }));
    }
    static exports(module: Module) {
      const description = modules.get(module);
      if (!description) throw new TypeError("Expected a WebAssembly.Module");
      return description.exports.map(({ name, kind }) => ({ name, kind }));
    }
  }
  class Memory {
    constructor() { throw new LinkError("Standalone WebAssembly memories are not supported"); }
    get buffer() { const state = memories.get(this); if (!state) throw new TypeError("Expected a WebAssembly.Memory"); return state.buffer; }
    grow(pages: unknown) {
      const state = memories.get(this);
      if (!state) throw new TypeError("Expected a WebAssembly.Memory");
      const count = index(pages);
      flush();
      let old;
      try { old = native.grow(state.id, state.name, count); }
      catch (error) { throw new RangeError(message(error)); }
      refresh();
      return old;
    }
  }
  class Global {
    constructor() { throw new LinkError("Standalone WebAssembly globals are not supported"); }
    get value() {
      const state = globals.get(this);
      if (!state) throw new TypeError("Expected a WebAssembly.Global");
      return decode(native.global(state.id, state.name), state.type);
    }
    set value(value: unknown) {
      const state = globals.get(this);
      if (!state) throw new TypeError("Expected a WebAssembly.Global");
      if (!state.mutable) throw new TypeError("Immutable WebAssembly global");
      native.global(state.id, state.name, coerce(value, state.type));
    }
    valueOf() { return this.value; }
  }
  function tableState(table: Table) {
    const state = tables.get(table);
    if (!state) throw new TypeError("Expected a WebAssembly.Table");
    return state;
  }
  class Table {
    constructor(descriptor: { element: string; initial?: unknown; minimum?: unknown; maximum?: unknown }, value?: unknown) {
      if (descriptor === null || typeof descriptor !== "object" && typeof descriptor !== "function") throw new TypeError("Expected a table descriptor");
      const element = String(descriptor.element);
      if (element !== "anyfunc" && element !== "funcref" && element !== "externref") throw new TypeError("Invalid WebAssembly table element type");
      const initial = descriptor.initial;
      if (initial === undefined) throw new TypeError("Missing WebAssembly table initial size");
      const minimum = index(initial);
      const maximumValue = descriptor.maximum;
      const maximum = maximumValue === undefined ? undefined : index(maximumValue);
      if (maximum !== undefined && maximum < minimum) throw new RangeError("Table maximum is smaller than initial");
      const type = element === "externref" ? element : "funcref";
      const init = value === undefined && type === "funcref" ? null : value;
      const encoded = coerce(init, type);
      let id;
      try { id = native.tableNew(type, minimum, maximum, encoded); }
      catch (error) { throw new RangeError(message(error)); }
      tables.set(this, { id, type });
      tableObjects.set(id, this);
    }
    get length() { return native.tableSize(tableState(this).id); }
    get(position: unknown) {
      const state = tableState(this);
      if (!arguments.length) throw new TypeError("Missing table index");
      return decode(native.tableGet(state.id, index(position)), state.type);
    }
    set(position: unknown, value?: unknown) {
      const state = tableState(this);
      if (!arguments.length) throw new TypeError("Missing table index");
      const at = index(position);
      const encoded = coerce(arguments.length < 2 && state.type === "funcref" ? null : value, state.type);
      native.tableSet(state.id, at, encoded);
    }
    grow(delta: unknown, value?: unknown) {
      const state = tableState(this);
      if (!arguments.length) throw new TypeError("Missing table growth size");
      const count = index(delta);
      const encoded = coerce(arguments.length < 2 && state.type === "funcref" ? null : value, state.type);
      return native.tableGrow(state.id, count, encoded);
    }
  }
  Object.defineProperty(Table, "length", { value: 1, configurable: true });
  Object.defineProperty(Table.prototype.grow, "length", { value: 1, configurable: true });
  Object.defineProperty(Table.prototype, Symbol.toStringTag, { value: "WebAssembly.Table", configurable: true });
  function flush() {
    for (const state of states) for (const memory of state.memories) native.write(state.id, memory.name, snapshot(memory.buffer));
  }
  function refresh() {
    for (const state of states) for (const memory of state.memories) refreshMemory(state, memory);
  }
  function refreshMemory(state: State, memory: MemoryRecord) {
    const { bytes, generation } = native.read(state.id, memory.name);
    if (memory.generation !== generation) {
      memory.buffer.transfer(0);
      memory.buffer = new ArrayBuffer(bytes.byteLength);
      memoryBuffers.add(memory.buffer);
      memory.generation = generation;
    }
    new Uint8Array(memory.buffer).set(bytes);
  }
  function execute(action: () => BunWasm.WasmCall) {
    try { return action(); }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new RuntimeError(message(error));
    }
  }
  function coerce(value: unknown, type: string): Wire {
    if (type === "i32") return (value as number) >> 0;
    if (type === "i64") return BigInt.asIntN(64, value as bigint);
    if (type === "f32") return Math.fround(+(value as number));
    if (type === "f64") return +(value as number);
    if (value === null) return null;
    if (type === "funcref") {
      const id = typeof value === "function" ? functionIds.get(value) : undefined;
      if (id === undefined) throw new TypeError("Expected an exported WebAssembly function or null");
      return id;
    }
    if (type !== "externref") throw new TypeError("Unsupported WebAssembly value type");
    let id = referenceIds.get(value);
    if (id !== undefined) return id;
    id = references.length;
    references.push(value);
    referenceIds.set(value, id);
    return id;
  }
  function decode(value: Wire, type: string): unknown {
    if (value === null) return null;
    if (type === "funcref") return wasmFunction(Number(value));
    if (type === "externref") return references[Number(value)];
    return value;
  }
  function wasmFunction(id: number): Function {
    const cached = functionObjects.get(id);
    if (cached) return cached;
    const signature = native.functionType(id);
    const callback = (...args: unknown[]) => invoke(id, signature, args);
    Object.defineProperty(callback, "length", { value: signature.params.length, configurable: true });
    functionIds.set(callback, id);
    functionObjects.set(id, callback);
    return callback;
  }
  function invoke(id: number, signature: Signature, args: unknown[]) {
    const inputs = signature.params.map((type, index) => coerce(args[index], type));
    flush();
    let result;
    try { result = execute(() => native.call(id, inputs)); }
    finally { refresh(); }
    while ("import" in result) result = imported(result);
    const values = result.values.map((value, index) => decode(value, signature.results[index]));
    return values.length === 1 ? values[0] : values.length === 0 ? undefined : values;
  }
  function imported(result: BunWasm.WasmImportCall) {
    const entry = imports[result.import];
    let values: Wire[];
    try {
      const value = entry.callback(...result.args.map((value, index) => decode(value, entry.params[index])));
      if (entry.results.length === 0) values = [];
      else if (entry.results.length === 1) values = [coerce(value, entry.results[0])];
      else {
        const returned = Array.from(value as Iterable<unknown>);
        if (returned.length !== entry.results.length) throw new TypeError("Invalid WebAssembly result count");
        values = returned.map((value, index) => coerce(value, entry.results[index]));
      }
    } catch (error) { if ("call" in result) native.cancel(result.call); throw error; }
    if ("direct" in result) return { values };
    flush();
    try { return execute(() => native.resume(result.call, values)); }
    finally { refresh(); }
  }
  class Instance {
    constructor(module: Module, provided: Record<string, Record<string, unknown>> = {}) {
      const description = modules.get(module);
      if (!description) throw new TypeError("Expected a WebAssembly.Module");
      const entries = description.imports.map(item => {
        const value = provided[item.module]?.[item.name];
        if (item.kind === "table" && value instanceof Table) return tableState(value).id;
        if (item.kind !== "function" || typeof value !== "function") throw new LinkError(`Missing WebAssembly import ${item.module}.${item.name}`);
        const id = functionIds.get(value);
        if (id !== undefined) return id;
        const index = imports.length;
        imports.push({ callback: value, params: item.params, results: item.results });
        return [index];
      });
      let id;
      try { id = native.instantiate(description.id, entries); }
      catch (error) { throw new LinkError(message(error)); }
      const state: State = { id, memories: [], memoryObjects: new Map() };
      const exports: Record<string, unknown> = Object.create(null);
      for (const item of description.exports) installExport(state, exports, item);
      states.push(state);
      refresh();
      Object.defineProperty(this, "exports", { value: Object.freeze(exports), enumerable: true });
    }
  }
  function installExport(state: State, exports: Record<string, unknown>, item: BunWasm.WasmExport) {
    const name = item.name;
    if (item.kind === "function") { exports[name] = wasmFunction(native.function(state.id, name)); return; }
    if (item.kind === "global") {
      const global: Global = Object.create(Global.prototype);
      globals.set(global, { id: state.id, name, type: item.type, mutable: item.mutable });
      exports[name] = global;
      return;
    }
    if (item.kind === "table") {
      const id = native.table(state.id, name);
      let table = tableObjects.get(id);
      if (!table) { table = Object.create(Table.prototype) as Table; tables.set(table, { id, type: item.type }); tableObjects.set(id, table); }
      exports[name] = table;
      return;
    }
    const identity = native.memoryIdentity(state.id, name);
    if (state.memoryObjects.has(identity)) { exports[name] = state.memoryObjects.get(identity); return; }
    const memory: Memory = Object.create(Memory.prototype);
    const record = { id: state.id, name, buffer: new ArrayBuffer(0) };
    memories.set(memory, record);
    state.memories.push(record);
    state.memoryObjects.set(identity, memory);
    exports[name] = memory;
  }
  async function compile(source: unknown) { return new Module(source); }
  async function instantiate(source: unknown, imports?: Record<string, Record<string, unknown>>) {
    if (source instanceof Module) return new Instance(source, imports);
    const module = new Module(source);
    return { module, instance: new Instance(module, imports) };
  }
  function validate(source: unknown) { return native.validate(snapshot(source)); }
  return { Module, Instance, Memory, Global, Table, CompileError, LinkError, RuntimeError, compile, instantiate, validate,
    compileStreaming: async (response: Response | Promise<Response>) => compile(await (await response).arrayBuffer()),
    instantiateStreaming: async (response: Response | Promise<Response>, imports?: Record<string, Record<string, unknown>>) => instantiate(await (await response).arrayBuffer(), imports),
  };
})
