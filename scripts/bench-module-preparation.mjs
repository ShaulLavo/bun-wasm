import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { WASI } from 'node:wasi';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const modulePath = resolve(root, 'web/src/engine-host.js');
const source = readFileSync(modulePath, 'utf8')
  .replace('import { installNativeStreamState } from "./native-stream-state.ts";', 'const installNativeStreamState = () => () => {};')
  .replace('"@bun-wasm/runtime/core/memory-views"', JSON.stringify(pathToFileURL(createRequire(modulePath).resolve('@bun-wasm/runtime/core/memory-views')).href))
  .replace('"./buffer-transfer.ts"', JSON.stringify(pathToFileURL(resolve(root, 'web/src/buffer-transfer.ts')).href))
  .replace('"./content-modules.ts"', JSON.stringify(pathToFileURL(resolve(root, 'web/src/content-modules.ts')).href))
  .replace('"./promise-reactions.ts"', JSON.stringify(pathToFileURL(resolve(root, 'web/src/promise-reactions.ts')).href))
  .replace('"./crypto-inputs.js"', JSON.stringify(pathToFileURL(resolve(root, 'web/src/crypto-inputs.js')).href))
  .replace('"./crypto-host.js"', JSON.stringify(pathToFileURL(resolve(root, 'web/src/crypto-host.js')).href))
  .concat('\nexport { wasmCaller };\n');
const { wasmCaller } = await import('data:text/javascript;base64,'.concat(Buffer.from(source).toString('base64')));
if (process.argv[2] === '--check') process.exit(0);
const dir = mkdtempSync('/work/tmp/bun-wasm-module-preparation-');
try {
const mode = process.argv[3] || 'hostModuleSource';
const count = 12_000;
const plain = Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join('\n').concat('\nexport const answer = v11999;\n');
const awaitCode = plain.concat('\nawait Promise.resolve();\n');
for (const [name, code] of [['large.mjs', plain], ['await.mjs', awaitCode], ['large.ts', plain.concat('\nconst typed: number = 1;\n')]]) writeFileSync(resolve(dir, name), code);
const wasm = process.argv[2];
const wasi = new WASI({ version: 'preview1', args: ['bun', 'run', '/large.mjs'], env: { PWD: '/', HOME: '/' }, preopens: { '/': dir }, returnOnExit: true });
const module = await WebAssembly.compile(readFileSync(wasm));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
wasi.start(instance);
const caller = wasmCaller(instance.exports);
const names = caller.describe().natives;
const native = name => (...args) => caller.call(names.indexOf(name), args);
const prepare = native('hostModuleSource');
const cjs = native('hostCjsSource');
const results = { wasm, mode, files: {} };
for (const name of ['large.mjs', 'await.mjs', 'large.ts']) {
  const path = '/'.concat(name);
  const start = performance.now();
  const info = prepare(path);
  const cold = performance.now() - start;
  if (info.format !== 'esm') throw new Error('expected esm');
  const fn = mode === 'hostCjsSource' ? cjs : prepare;
  for (let i = 0; i < 5; i++) fn(path);
  const samples = [];
  for (let i = 0; i < 31; i++) {
    const now = performance.now();
    fn(path);
    samples.push(performance.now() - now);
  }
  samples.sort((a, b) => a - b);
  results.files[name] = { bytes: readFileSync(resolve(dir, name)).byteLength, coldMs: cold, warmMedianMs: samples[15], p10: samples[3], p90: samples[27] };
}
results.freshModuleMedianMs = {};
for (const [name, code] of [['plain', plain], ['await', awaitCode], ['typescript', plain.concat('\nconst typed: number = 1;\n')]]) {
  const ext = name === 'typescript' ? '.ts' : '.mjs';
  const samples = [];
  for (let i = 0; i < 15; i++) {
    const file = name.concat('-', String(i), ext);
    writeFileSync(resolve(dir, file), code);
    const start = performance.now();
    prepare('/'.concat(file));
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results.freshModuleMedianMs[name] = samples[7];
}
console.log(JSON.stringify(results, null, 2));

} finally { rmSync(dir, { recursive: true, force: true }); }
