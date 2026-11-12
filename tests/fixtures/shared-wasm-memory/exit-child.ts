const start = process.argv[2] === 'start';
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/${start ? 'start' : 'imported'}.wasm`).arrayBuffer());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
try {
  const instance = new WebAssembly.Instance(module, { env: { memory, observe() { process.exit(start ? 9 : 7); } } });
  const callback = instance.exports.callback;
  if (typeof callback !== 'function') throw new Error('Missing callback');
  callback();
} catch { console.log('caught fatal exit'); }
console.log('continued after fatal exit');
