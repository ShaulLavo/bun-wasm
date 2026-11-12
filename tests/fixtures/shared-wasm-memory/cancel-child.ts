import { writeFileSync } from 'node:fs';

const mode = process.argv[2];
const marker = process.argv[3];
if (!marker) throw new Error('Missing readiness marker');
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const words = new Int32Array(memory.buffer);
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());
// This process blocks inside Wasm and never runs its event loop again, so stdio cannot report it.
function ready() { writeFileSync(marker!, ''); }
function observe() { ready(); Atomics.wait(words, 0, 0); }
const instance = new WebAssembly.Instance(module, { env: { memory, observe } });
const wait = instance.exports.wait;
const callback = instance.exports.callback;
if (typeof wait !== 'function' || typeof callback !== 'function') throw new Error('Missing wait exports');
if (mode === 'js') callback();
else { ready(); wait(0, -1n); }
