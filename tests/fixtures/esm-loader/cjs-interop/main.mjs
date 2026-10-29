import lib, { named, counter } from './lib.cjs';
import * as ns from './lib.cjs';
console.log(lib.named, named, counter, typeof ns.default, ns.named);
lib.bump();
console.log('named exports are snapshots', counter, lib.counter);
