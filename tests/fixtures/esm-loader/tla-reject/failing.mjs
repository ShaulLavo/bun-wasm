import { inner } from './inner.mjs';
console.log('failing start', inner);
await null;
export const never = 1;
throw new Error('rejected after await');
