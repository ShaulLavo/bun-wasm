import * as ns from './mod.mjs';
console.log(Object.prototype.toString.call(ns), Object.getPrototypeOf(ns) === null);
console.log(Object.isExtensible(ns), Object.keys(ns).join(','));
console.log(typeof ns.default, ns.default(), ns.b, 'zeta' in ns);
const self = await import('./mod.mjs');
console.log('same namespace', self === ns);
