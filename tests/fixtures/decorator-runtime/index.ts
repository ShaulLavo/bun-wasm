import assert from "node:assert/strict";

const calls: string[] = [];
function field(_value: undefined, context: ClassFieldDecoratorContext) {
  context.addInitializer(function () { calls.push(String(context.name)); });
  return (value: number) => value * 2;
}
function method(value: (this: unknown) => number, _context: ClassMethodDecoratorContext) {
  return function (this: unknown) { return value.call(this) + 1; };
}
class Example {
  @field value = 3;
  @method read() { return this.value; }
}
assert.equal(new Example().read(), 7);
assert.deepEqual(calls, ["value"]);
console.log("Bun decorator helpers");
