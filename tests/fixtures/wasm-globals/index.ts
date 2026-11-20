import { readFileSync } from 'node:fs';
import { runGlobalControls } from './controls.ts';
runGlobalControls(WebAssembly, name => new WebAssembly.Module(readFileSync(`${import.meta.dir}/${name}.wasm`)), (condition, label) => {
  if (!condition) throw new Error(label);
});
