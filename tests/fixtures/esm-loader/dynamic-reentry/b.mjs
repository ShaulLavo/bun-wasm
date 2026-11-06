import * as self from './b.mjs';
import { fromA } from './a.mjs';
export const fromB = 'B';
export const readA = () => fromA;
globalThis.bSelf = self;
console.log('b');
