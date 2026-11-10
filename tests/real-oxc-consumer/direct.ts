import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
try {
  const binding = require('@oxc-parser/binding-wasm32-wasi');
  console.log('official Wasm binding loaded', typeof binding.parseSync);
} catch (error) {
  console.log('official Wasm binding error', error.name, error.message);
}
try {
  new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true });
  console.log('shared memory created');
} catch (error) {
  console.log('shared memory error', error.name, error.message);
}
