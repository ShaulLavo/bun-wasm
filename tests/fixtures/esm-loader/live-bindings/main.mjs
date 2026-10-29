import { count, increment, alias, reset } from './counter.mjs';
import * as ns from './counter.mjs';
console.log(count, alias, ns.count);
increment(); increment();
console.log(count, alias, ns.count);
reset();
console.log(count, ns.count);
let threw = false;
try { ns.count = 5; } catch (error) { threw = error instanceof TypeError; }
console.log('assign to namespace throws', threw);
