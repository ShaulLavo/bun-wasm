(function (internal) {
  'use strict';
  const native = internal.native.wasm;
  const modules = new WeakMap();
  const instances = new WeakMap();
  const memoryBuffers = new WeakSet();
  internal.isWasmMemoryBuffer = value => memoryBuffers.has(value);
  class CompileError extends Error { constructor(message) { super(message); this.name = 'CompileError'; } }
  class LinkError extends Error { constructor(message) { super(message); this.name = 'LinkError'; } }
  class RuntimeError extends Error { constructor(message) { super(message); this.name = 'RuntimeError'; } }
  function byteView(source) {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    throw new TypeError('Expected a WebAssembly BufferSource');
  }
  class Module {
    constructor(source) {
      const input = byteView(source);
      try { modules.set(this, native.compile(input)); }
      catch (error) { throw new CompileError(error.message); }
    }
    static imports(module) { return modules.get(module).imports.map(({ module, name, kind }) => ({ module, name, kind })); }
    static exports(module) { return modules.get(module).exports.map(({ name, kind }) => ({ name, kind })); }
  }
  class Memory {
    constructor() { throw new LinkError('Standalone WebAssembly memories are not supported'); }
    get buffer() { return instances.get(this).buffer; }
    grow(pages) {
      const state = instances.get(this);
      if (!state?.owner) throw new TypeError('Expected a WebAssembly.Memory');
      const count = Math.trunc(+pages);
      if (!Number.isFinite(count) || count < 0 || count > 0xffffffff) throw new TypeError('Invalid WebAssembly page count');
      flush(state.owner);
      let old;
      try { old = native.grow(state.id, state.name, count); }
      catch (error) { throw new RangeError(error.message); }
      refresh(state.owner);
      return old;
    }
  }
  class Global {
    constructor() { throw new LinkError('Standalone WebAssembly globals are not supported'); }
    get value() { const state = instances.get(this); return native.global(state.id, state.name); }
    set value(value) {
      const state = instances.get(this);
      if (!state.mutable) throw new TypeError('Immutable WebAssembly global');
      native.global(state.id, state.name, coerce(value, state.type));
    }
    valueOf() { return this.value; }
  }
  function flush(state) {
    for (const memory of state.memories) native.write(state.id, memory.name, byteView(memory.buffer));
  }
  function refresh(state) {
    for (const memory of state.memories) {
      const { bytes: data, generation } = native.read(state.id, memory.name);
      if (memory.generation !== generation) {
        memory.buffer.transfer(0);
        memory.buffer = new ArrayBuffer(data.byteLength);
        memoryBuffers.add(memory.buffer);
        memory.generation = generation;
      }
      new Uint8Array(memory.buffer).set(data);
    }
  }
  function execute(action) {
    try { return action(); }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new RuntimeError(error.message);
    }
  }
  function coerce(value, type) {
    switch (type) {
      case 'i32': return value >> 0;
      case 'i64': return BigInt.asIntN(64, value);
      case 'f32': return Math.fround(+value);
      case 'f64': return +value;
      default: throw new TypeError('WebAssembly reference values are not supported');
    }
  }
  function invoke(state, item, args) {
    const inputs = item.params.map((type, index) => coerce(args[index], type));
    flush(state);
    let result;
    try { result = execute(() => native.call(state.id, item.name, inputs)); }
    finally { refresh(state); }
    while (result.import !== undefined) result = imported(state, result);
    const values = result.values;
    if (values.length === 1) return values[0];
    return values.length === 0 ? undefined : values;
  }
  function imported(state, result) {
    const entry = state.imports[result.import];
    let values;
    try {
      const value = entry.callback(...result.args);
      if (entry.results.length === 0) values = [];
      else if (entry.results.length === 1) values = [coerce(value, entry.results[0])];
      else {
        values = [...value];
        if (values.length !== entry.results.length) throw new TypeError('Invalid WebAssembly result count');
        values = values.map((value, index) => coerce(value, entry.results[index]));
      }
    } catch (error) { native.cancel(state.id, result.call); throw error; }
    flush(state);
    try { return execute(() => native.resume(state.id, result.call, values)); }
    finally { refresh(state); }
  }
  class Instance {
    constructor(module, imports = {}) {
      const description = modules.get(module);
      if (!description) throw new TypeError('Expected a WebAssembly.Module');
      const functions = description.imports.map(item => {
        const value = imports[item.module]?.[item.name];
        if (item.kind !== 'function' || typeof value !== 'function') throw new LinkError(`Missing WebAssembly import ${item.module}.${item.name}`);
        return { callback: value, results: item.results };
      });
      let id;
      try { id = native.instantiate(description.id); }
      catch (error) { throw new LinkError(error.message); }
      const state = { id, imports: functions, memories: [], memoryObjects: new Map() };
      const exports = Object.create(null);
      for (const item of description.exports) installExport(state, exports, item);
      refresh(state);
      Object.defineProperty(this, 'exports', { value: Object.freeze(exports), enumerable: true });
    }
  }
  function installExport(state, exports, item) {
    const name = item.name;
    if (item.kind === 'function') { exports[name] = (...args) => invoke(state, item, args); return; }
    if (item.kind === 'global') {
      const global = Object.create(Global.prototype);
      instances.set(global, { id: state.id, name, type: item.type, mutable: item.mutable });
      exports[name] = global;
      return;
    }
    if (item.kind !== 'memory') throw new LinkError(`Unsupported WebAssembly export ${item.kind}`);
    const identity = native.memoryIdentity(state.id, name);
    if (state.memoryObjects.has(identity)) { exports[name] = state.memoryObjects.get(identity); return; }
    const memory = Object.create(Memory.prototype);
    const record = { id: state.id, name, buffer: new ArrayBuffer(0), owner: state, generation: undefined };
    instances.set(memory, record);
    state.memories.push(record);
    state.memoryObjects.set(identity, memory);
    exports[name] = memory;
  }
  async function compile(source) { return new Module(source); }
  async function instantiate(source, imports) {
    if (source instanceof Module) return new Instance(source, imports);
    const module = new Module(source);
    return { module, instance: new Instance(module, imports) };
  }
  function validate(source) { return native.validate(byteView(source)); }
  return { Module, Instance, Memory, Global, CompileError, LinkError, RuntimeError, compile, instantiate, validate,
    compileStreaming: async response => compile(await (await response).arrayBuffer()),
    instantiateStreaming: async (response, imports) => instantiate(await (await response).arrayBuffer(), imports),
  };
})
