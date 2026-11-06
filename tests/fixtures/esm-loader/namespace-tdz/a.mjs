// Reading an uninitialized export through the namespace throws, enumeration included;
// key and membership checks do not.
import * as self from './a.mjs';
const attempt = f => { try { return String(f()); } catch (error) { return error.constructor.name; } };
console.log('keys', attempt(() => Object.keys(self).join()));
console.log('descriptor', attempt(() => JSON.stringify(Reflect.getOwnPropertyDescriptor(self, 'late'))));
console.log('define', attempt(() => Reflect.defineProperty(self, 'late', {})));
console.log('read', attempt(() => self.late));
console.log('own keys', Reflect.ownKeys(self).map(String).join(), 'late' in self);
export let late = 1;
console.log('after', Object.keys(self).join(), self.late);
