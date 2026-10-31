import assert from "node:assert/strict";

const metadata = new WeakMap<object, Map<string | symbol | undefined, Map<string, unknown>>>();
Object.defineProperty(Reflect, "metadata", {
  value: (name: string, value: unknown) => (target: object, key?: string | symbol) => {
    let members = metadata.get(target);
    if (!members) metadata.set(target, members = new Map());
    let values = members.get(key);
    if (!values) members.set(key, values = new Map());
    values.set(name, value);
  },
});

const { Dependency, ProductController, parameters } = await import("./src/controller.ts");
assert.deepEqual(metadata.get(ProductController)?.get(undefined)?.get("design:paramtypes"), [Dependency]);
const method = metadata.get(ProductController.prototype)?.get("item");
assert.equal(method?.get("design:type"), Function);
assert.deepEqual(method?.get("design:paramtypes"), [Number, String]);
assert.equal(method?.get("design:returntype"), String);
assert.equal(Reflect.get(ProductController.prototype.item, "x-product-framework"), "nestjs");
assert.deepEqual(parameters, [1, 0]);
assert.equal(new ProductController(new Dependency()).item(42, "matrix"), "42:matrix");
console.log("project decorator config and metadata");
