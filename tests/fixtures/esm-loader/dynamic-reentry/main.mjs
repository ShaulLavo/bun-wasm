// A cycle member dynamically imports another member while the cycle is still evaluating.
import * as a from './a.mjs';
const again = await import('./a.mjs');
await globalThis.reentry;
console.log('main', again === a, a.fromA);
