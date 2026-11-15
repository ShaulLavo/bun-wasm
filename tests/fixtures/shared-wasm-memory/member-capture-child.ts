console.error('member capture buffered stderr');
if (process.argv[2] === 'exit') process.exit(7);
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/imported.wasm`).arrayBuffer());
const instance = new WebAssembly.Instance(module, { env: { memory, observe() {} } });
const wait = instance.exports.wait;
if (typeof wait !== 'function') throw new Error('Missing wait export');
wait(0, -1n);
throw new Error('The capture control wait unexpectedly returned');
