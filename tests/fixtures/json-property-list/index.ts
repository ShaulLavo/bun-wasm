function assert(value, message) {
  if (!value) throw new Error(message);
}

const sentinel = {};
function sameError(callback) {
  let caught;
  try { callback(); } catch (error) { caught = error; }
  assert(caught === sentinel, "thrown identity");
}

function poisoned(prototype, descriptor, callback) {
  try {
    for (let index = 0; index < 3; index++) {
      Object.defineProperty(prototype, String(index), { configurable: true, ...descriptor });
    }
    callback();
  } finally {
    for (let index = 0; index < 3; index++) Reflect.deleteProperty(prototype, String(index));
  }
}

const dense = ["a"];
let reads = 0;
let writes = 0;
const hooks = {
  get() { reads++; throw sentinel; },
  set() { writes++; throw sentinel; },
};
function denseResult() {
  assert(JSON.stringify({ a: 1, b: 2 }, dense) === '{"a":1}', "dense replacer");
}
poisoned(Array.prototype, { get: hooks.get }, denseResult);
poisoned(Array.prototype, hooks, denseResult);
poisoned(Array.prototype, { value: "wrong", writable: false }, denseResult);
poisoned(Object.prototype, hooks, denseResult);
assert(reads === 0 && writes === 0, "private property-list hooks");
console.log("private property-list hooks: 0");

const sparse = new Array(1);
poisoned(Array.prototype, { get() { reads++; return "a"; } }, () => {
  assert(JSON.stringify({ a: 1, b: 2 }, sparse) === '{"a":1}', "public sparse replacer");
});
assert(reads === 1, "public sparse getter count");
poisoned(Array.prototype, { get: hooks.get }, () => sameError(() => JSON.stringify({ a: 1 }, sparse)));
assert(reads === 2, "public throwing getter count");
poisoned(Array.prototype, { set() { writes++; } }, () => {
  const publicArray = [];
  assert(publicArray.push("a") === 1 && !Object.hasOwn(publicArray, "0"), "public push");
});
assert(writes === 1, "public setter count");
console.log("public sparse getters and setter preserved");

let conversions = 0;
const boxed = new String("unused");
boxed.toString = function () { conversions++; return "b"; };
const keys = [boxed, "a", "b", new Number(2), 2, null, {}, true];
poisoned(Array.prototype, hooks, () => {
  assert(JSON.stringify({ a: 1, b: 2, 2: 3, unused: 4 }, keys) === '{"b":2,"a":1,"2":3}', "order and deduplication");
});
assert(conversions === 1, "conversion count");
const badKey = new String("a");
badKey.toString = function () { throw sentinel; };
sameError(() => JSON.stringify({ a: 1 }, [badKey]));
console.log("replacer conversion, order, deduplication and thrown identity passed");

const shared = { a: 2 };
const cycle = {};
cycle.a = cycle;
let toJSON = 0;
let gets = 0;
const reentrant = {
  get a() { gets++; return JSON.stringify({ a: 3 }, dense); },
  b: { toJSON(key) { toJSON++; assert(key === "b", "toJSON key"); return shared; } },
};
const nestedKeys = ["a", "b"];
poisoned(Array.prototype, hooks, () => {
  assert(JSON.stringify({ a: shared, b: shared }, nestedKeys) === '{"a":{"a":2},"b":{"a":2}}', "shared values");
  assert(JSON.stringify(reentrant, nestedKeys) === '{"a":"{\\"a\\":3}","b":{"a":2}}', "reentrant getter and toJSON");
  sameError(() => JSON.stringify({ get a() { throw sentinel; } }, dense));
  sameError(() => JSON.stringify({ toJSON() { throw sentinel; } }, dense));
});
assert(gets === 1 && toJSON === 1, "callback counts");
function typeError(value) {
  let caught;
  try { JSON.stringify(value, dense); } catch (error) { caught = error; }
  assert(caught instanceof TypeError, "cycle or BigInt error");
}
poisoned(Array.prototype, hooks, () => {
  typeError(cycle);
  typeError({ a: 1n });
  denseResult();
});
assert(writes === 1 && reads === 2, "private hooks after reentry and errors");
console.log("shared values, cycles, toJSON, reentry and recovery passed");
