import { fromA, late } from './a.mjs';
console.log('b body', fromA());
try { console.log(late); } catch (error) { console.log('b tdz', error.constructor.name); }
export function useA() { return fromA() + ' via b'; }
export function readLate() { return late; }
