import { whoIsThis, sloppyThis } from './dep.mjs';
console.log('top-level this is nullish', this == null);
console.log('import call this', whoIsThis());
console.log('sloppy call gets global', sloppyThis() === globalThis);
