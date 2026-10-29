import { useA, readLate } from './b.mjs';
console.log('a body', useA());
export function fromA() { return 'fromA'; }
export let late = 'late value';
export const early = readLate();
