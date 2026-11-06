import * as nsB from './b.mjs';
export const fromA = 'A';
console.log('a-start');
globalThis.reentry = import('./b.mjs').then(m => console.log('a-dyn', m.fromB, m === nsB, m === globalThis.bSelf));
