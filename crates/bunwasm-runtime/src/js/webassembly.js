(function (internal) {
  'use strict';
  const native = internal.native.wasm;
  const modules = new WeakMap();
  const instances = new WeakMap();
  class CompileError extends Error { constructor(message) { super(message); this.name = 'CompileError'; } }
  class LinkError extends Error { constructor(message) { super(message); this.name = 'LinkError'; } }
  class RuntimeError extends Error { constructor(message) { super(message); this.name = 'RuntimeError'; } }
  function snapshot(source) {
    // JSC pins buffers passed through its C API. Native calls must own their snapshots.
    if (source instanceof ArrayBuffer) return new Uint8Array(source).slice();
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
    throw new TypeError('Expected a WebAssembly BufferSource');
  }
  class Module {
    constructor(source) {
      const input = snapshot(source);
      try { modules.set(this, native.compile(input)); }
      catch (error) { throw new CompileError(error.message); }
    }
    static imports(module) { return modules.get(module).imports.map(item => Object.assign({}, item)); }
    static exports(module) { return modules.get(module).exports.map(item => Object.assign({}, item)); }
  }
  class Memory {
    constructor() { throw new LinkError('Standalone WebAssembly memories are not supported'); }
    get buffer() { return instances.get(this).buffer; }
    grow(pages) {
      const state = instances.get(this);
      flush(state.owner);
      let old;
      try { old = native.grow(state.id, state.name, pages); }
      catch (error) { throw new RangeError(error.message); }
      refresh(state.owner);
      return old;
    }
  }
  class Global {
    constructor() { throw new LinkError('Standalone WebAssembly globals are not supported'); }
    get value() { const state = instances.get(this); return native.global(state.id, state.name); }
    set value(value) { const state = instances.get(this); native.global(state.id, state.name, value); }
    valueOf() { return this.value; }
  }
  function flush(state) {
    for (const memory of state.memories) native.write(state.id, memory.name, snapshot(memory.buffer));
  }
  function refresh(state) {
    for (const memory of state.memories) {
      const data = native.read(state.id, memory.name);
      if (memory.buffer.byteLength !== data.byteLength) {
        memory.buffer.transfer(0);
        memory.buffer = new ArrayBuffer(data.byteLength);
      }
      new Uint8Array(memory.buffer).set(data);
    }
  }
  function execute(action) {
    try { return action(); } catch (error) { throw new RuntimeError(error.message); }
  }
  function invoke(state, name, args) {
    flush(state);
    let result;
    try { result = execute(() => native.call(state.id, name, args)); }
    finally { refresh(state); }
    while (result.import !== undefined) result = imported(state, result);
    const values = result.values;
    if (values.length === 1) return values[0];
    return values.length === 0 ? undefined : values;
  }
  function imported(state, result) {
    let value;
    try { value = state.imports[result.import](...result.args); }
    catch (error) { native.cancel(state.id, result.call); throw error; }
    flush(state);
    const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
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
        return value;
      });
      let id;
      try { id = native.instantiate(description.id); }
      catch (error) { throw new LinkError(error.message); }
      const state = { id, imports: functions, memories: [] };
      const exports = Object.create(null);
      for (const item of description.exports) installExport(state, exports, item);
      refresh(state);
      Object.defineProperty(this, 'exports', { value: Object.freeze(exports), enumerable: true });
    }
  }
  function installExport(state, exports, item) {
    const name = item.name;
    if (item.kind === 'function') { exports[name] = (...args) => invoke(state, name, args); return; }
    if (item.kind === 'global') {
      const global = Object.create(Global.prototype);
      instances.set(global, { id: state.id, name });
      exports[name] = global;
      return;
    }
    if (item.kind !== 'memory') throw new LinkError(`Unsupported WebAssembly export ${item.kind}`);
    const memory = Object.create(Memory.prototype);
    const record = { id: state.id, name, buffer: new ArrayBuffer(0), owner: state };
    instances.set(memory, record);
    state.memories.push(record);
    exports[name] = memory;
  }
  async function compile(source) { return new Module(source); }
  async function instantiate(source, imports) {
    if (source instanceof Module) return new Instance(source, imports);
    const module = new Module(source);
    return { module, instance: new Instance(module, imports) };
  }
  function validate(source) { return native.validate(snapshot(source)); }
  return { Module, Instance, Memory, Global, CompileError, LinkError, RuntimeError, compile, instantiate, validate,
    compileStreaming: async response => compile(await (await response).arrayBuffer()),
    instantiateStreaming: async (response, imports) => instantiate(await (await response).arrayBuffer(), imports),
  };
})
