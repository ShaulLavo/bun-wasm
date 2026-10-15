import { readFileSync } from 'node:fs';
const bytes = readFileSync('/module.wasm');
console.log(WebAssembly.validate(bytes), WebAssembly.validate(new Uint8Array([1])));
const module = new WebAssembly.Module(bytes);
console.log(WebAssembly.Module.imports(module)[0].name);
let instance;
instance = new WebAssembly.Instance(module, { env: { callback(value) {
  console.log('callback', instance.exports.load());
  instance.exports.store(23);
  return instance.exports.add(value, 2);
} } });
const e = instance.exports;
new Uint8Array(e.memory.buffer)[0] = 12;
console.log(e.add(2, 3), e.invoke(5), e.load());
const previous = e.memory.buffer;
console.log(e.grow(), previous.byteLength, e.memory.buffer.byteLength, e.load());
console.log(e.wide(9007199254740993n), e.pair().join(','));
console.log(e.counter.value);
e.counter.value = 6;
console.log(e.counter.value);
try { e.trap(); } catch (error) { console.log(error instanceof WebAssembly.RuntimeError); }
const result = await WebAssembly.instantiate(bytes, { env: { callback: value => value } });
console.log(result.module instanceof WebAssembly.Module, result.instance.exports.add(3, 4));

const rejected = new Error('import rejected');
const throwing = new WebAssembly.Instance(module, { env: { callback() { throw rejected; } } });
try { throwing.exports.invoke(1); } catch (error) { console.log(error === rejected); }
console.log(throwing.exports.add(4, 5));
console.log(await WebAssembly.instantiate(module, { env: { callback: n => n } }) instanceof WebAssembly.Instance);
try { await WebAssembly.compile(new Uint8Array([1])); } catch (error) { console.log(error instanceof WebAssembly.CompileError); }
