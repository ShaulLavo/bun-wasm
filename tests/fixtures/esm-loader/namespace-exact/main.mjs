// Module namespace objects (ECMA-262 10.4.6): key order, data descriptors and the
// [[DefineOwnProperty]], [[Set]], [[Delete]] and prototype rules.
import * as ns from './mod.mjs';
import * as empty from './empty.mjs';

const attempt = f => { try { return String(f()); } catch (error) { return error.constructor.name; } };
console.log(Reflect.ownKeys(ns).map(String).join());
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(ns, 'a')));
console.log(Object.isFrozen(ns), Object.isSealed(ns), Object.isExtensible(ns), Object.getPrototypeOf(ns));
console.log(Object.prototype.toString.call(ns), 'a' in ns, 'zz' in ns);
console.log(Reflect.set(ns, 'a', 2), Reflect.set(ns, 'zz', 2), Reflect.deleteProperty(ns, 'a'), Reflect.deleteProperty(ns, 'zz'));
console.log(Reflect.deleteProperty(ns, Symbol.toStringTag), Reflect.deleteProperty(ns, Symbol.iterator));
console.log(Reflect.defineProperty(ns, 'a', { value: 'a' }), Reflect.defineProperty(ns, 'a', { value: 'b' }), Reflect.defineProperty(ns, 'a', {}));
console.log(Reflect.defineProperty(ns, 'a', { writable: false }), Reflect.defineProperty(ns, 'a', { enumerable: false }), Reflect.defineProperty(ns, 'a', { get() {} }));
console.log(Reflect.defineProperty(ns, 'nan', { value: NaN }), Reflect.defineProperty(ns, 'zero', { value: 0 }), Reflect.defineProperty(ns, 'zero', { value: -0 }));
console.log(Reflect.defineProperty(ns, 'zz', { value: 1 }), Reflect.setPrototypeOf(ns, null), Reflect.setPrototypeOf(ns, {}));
console.log(attempt(() => Object.freeze(ns)), attempt(() => Object.seal(ns) === ns), attempt(() => { 'use strict'; ns.a = 1; }));
console.log(Reflect.ownKeys(empty).map(String).join(), Object.isFrozen(empty), Object.isSealed(empty));
