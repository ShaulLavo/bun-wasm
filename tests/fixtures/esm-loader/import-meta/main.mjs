import { metaOf } from './dep.mjs';
console.log(import.meta.url.split('/').pop(), metaOf().split('/').pop());
console.log(import.meta === import.meta, typeof import.meta);
