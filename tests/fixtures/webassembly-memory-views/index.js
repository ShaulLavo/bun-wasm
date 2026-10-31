import { readFileSync } from 'node:fs';
const module = new WebAssembly.Module(readFileSync('./module.wasm'));
let mode = 'roundTrip', seen = [];
const env = { observe(kind) {
  const memory = instance.exports.memory;
  if (kind === 0) { const bytes = new Uint8Array(memory.buffer); seen.push(bytes[0]); bytes[1] = 9; return 100; }
  if (kind === 1) { seen.push(retained.byteLength, view.length, memory.buffer.byteLength); return 1; }
  return new DataView(memory.buffer).getUint32(64, true) === counter++ ? 1 : 0;
} };
let counter = 0, retained, view;
const instance = new WebAssembly.Instance(module, { env });
const e = instance.exports;

const buffer = e.memory.buffer;
const bytes = new Uint8Array(buffer), data = new DataView(buffer);
e.store(10, 42);
console.log('identity', e.memory.buffer === buffer, bytes[10], data.getUint8(10));
bytes[11] = 7; data.setUint8(12, 8);
console.log('js writes', e.load(11), e.load(12), e.memory.buffer === buffer);
console.log('import round trip', e.roundTrip(), seen.join(','), bytes[1]);

seen = []; retained = e.memory.buffer; view = new Uint8Array(retained);
console.log('grow in import', e.growThenObserve(), seen.join(','), retained.byteLength, e.memory.buffer.byteLength, new Uint8Array(e.memory.buffer)[10]);

const before = e.memory.buffer;
console.log('api grow zero', e.memory.grow(0), before.byteLength, e.memory.buffer.byteLength, new Uint8Array(e.memory.buffer)[11]);
const current = e.memory.buffer;
try { e.memory.grow(100000); } catch (error) { console.log('failed grow', error instanceof RangeError, e.memory.buffer === current); }
try { current.transfer(); console.log('transfer allowed'); } catch (error) { console.log('transfer', error instanceof TypeError, current.byteLength > 0); }
try { structuredClone(current, { transfer: [current] }); console.log('clone transfer allowed'); } catch (error) { console.log('clone transfer refused', current.byteLength > 0); }

const standalone = (() => { const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 }); return { buffer: memory.buffer, grow: () => memory.grow(1) }; })();
new Uint8Array(standalone.buffer)[0] = 3;
Bun.gc(true);
console.log('retained after wrapper gc', new Uint8Array(standalone.buffer)[0], standalone.grow(), standalone.buffer.byteLength);

console.log('wasm grow', e.grow(1000), e.memory.buffer.byteLength / 65536);
console.log('crossings', e.crossings(3000), counter);
