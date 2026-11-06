// One namespace object per module: static, self, `export * as`, `export { ns }` and
// dynamic import all see it. Bindings stay live and each module evaluates once.
import * as nsA from './a.mjs';
import * as r from './r.mjs';
import { inc, v } from './a.mjs';
const dyn = await import('./a.mjs');
console.log(globalThis.inside === nsA, r.nsA === nsA, r.again === nsA, dyn === nsA, (await import('./r.mjs')) === r);
const before = v;
inc();
console.log('live', before, v, nsA.v, globalThis.evaluations);
