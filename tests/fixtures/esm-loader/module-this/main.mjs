// Module code's `this` is undefined, also through typeof and equality; nested functions
// and classes keep their own; literal typeof/equality keep their structure.
const arrow = () => this;
console.log(this === undefined, typeof this, this === null, this == null, this !== undefined);
console.log(arrow() === undefined, typeof arrow(), (() => typeof this)());
function own() { return this; }
console.log(own() === undefined, own.call(5) instanceof Number);
class C { field = this; static stat = this; }
console.log(new C().field instanceof C, C.stat === C);
const shape = () => [typeof 1, 1 === 1, 'a' !== 'b', 2 == 2, 1 != void 0];
console.log(shape().join(), /typeof 1/.test(String(shape)), /1 === 1/.test(String(shape)), /void 0/.test(String(shape)));
