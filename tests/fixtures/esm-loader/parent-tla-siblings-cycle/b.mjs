import './a.mjs';
console.log('b-start');
await globalThis.gate;
console.log('b-end');
