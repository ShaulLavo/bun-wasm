import { v, late } from './dep.mjs';
console.log('main start', v, late);
await null;
console.log('main after await');
