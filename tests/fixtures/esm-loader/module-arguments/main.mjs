// A module's `arguments` is a global-scope reference: unresolvable until a global
// binding exists, then read, typeof'd and called (without a receiver) through it.
// Functions keep their own `arguments`.
const attempt = f => { try { return String(f()); } catch (error) { return error.constructor.name; } };
const lexical = () => typeof arguments;
console.log(typeof arguments, attempt(() => arguments), lexical());
globalThis.arguments = function (value) { return [this === undefined, value].join(); };
console.log(typeof arguments, arguments('called'), lexical(), arguments.name);
function own() { return arguments.length; }
console.log(own(1, 2, 3));
delete globalThis.arguments;
console.log(typeof arguments, attempt(() => arguments));
