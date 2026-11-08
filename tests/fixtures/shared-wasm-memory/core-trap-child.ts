const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
const module = new WebAssembly.Module(await Bun.file(`${import.meta.dir}/deep.wasm`).arrayBuffer());
let entered = 0;
let exited = 0;
let abandoned = false;
function recurse(depth: number): number { return depth === 0 ? 1 : 1 + recurse(depth - 1); }
const instance = new WebAssembly.Instance(module, { env: { memory, observe() { entered++; recurse(40); exited++; } } });
const deep = instance.exports.deep;
if (typeof deep !== 'function') throw new Error('Missing deep export');
function attempt(depth: number) {
  const before = entered;
  const completed = exited;
  try { deep(depth); return true; }
  catch { abandoned = entered > before && exited === completed; return false; }
}
// Locate this host's stack boundary, then exercise callbacks in the boundary band.
// A nested-only overflow is catchable. A core entry overflow must end the member.
function exerciseBoundary() {
  let low = 1000;
  let high = 4_000_000;
  while (!abandoned && high - low > 1) {
    const middle = (low + high) >> 1;
    if (attempt(middle)) low = middle;
    else high = middle;
  }
  for (let depth = low + 1; !abandoned && depth < low + 6000; depth++) attempt(depth);
}
// Browser tier-up shrinks nested frames after the first probes, which moves the boundary.
for (let round = 0; round < 6 && !abandoned; round++) exerciseBoundary();
console.log('continued after core stack trap');
