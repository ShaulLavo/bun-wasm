function assert(value, message) {
  if (!value) throw new Error(message);
}

function observed(callback, throwing = false) {
  const counts = { get: 0, set: 0 };
  const descriptor = {
    configurable: true,
    get() { counts.get++; return 7; },
    set() {
      counts.set++;
      if (throwing) throw new Error("private stack reached user setter");
    },
  };
  try {
    Object.defineProperty(Array.prototype, "0", descriptor);
    Object.defineProperty(Array.prototype, "1", descriptor);
    Object.defineProperty(Array.prototype, "2", descriptor);
    callback();
  } finally {
    Reflect.deleteProperty(Array.prototype, "0");
    Reflect.deleteProperty(Array.prototype, "1");
    Reflect.deleteProperty(Array.prototype, "2");
  }
  return counts;
}

function privateOnly(callback, throwing = false) {
  const counts = observed(callback, throwing);
  assert(counts.set === 0, `private setters: ${counts.set}`);
  assert(counts.get === 0, `private getters: ${counts.get}`);
}

function typeError(callback) {
  let caught;
  try { callback(); } catch (error) { caught = error; }
  assert(caught instanceof TypeError, "expected TypeError");
}

privateOnly(() => assert(JSON.stringify({ marker: 1 }) === '{"marker":1}', "simple JSON"));
console.log("private setter and getter counts: 0");

const shared = { value: 2 };
privateOnly(() => {
  assert(JSON.stringify({ a: [shared], b: shared }) === '{"a":[{"value":2}],"b":{"value":2}}', "nested shared JSON");
}, true);
const cycle = { self: null };
cycle.self = cycle;
privateOnly(() => {
  typeError(() => JSON.stringify(cycle));
  typeError(() => JSON.stringify({ nested: [cycle] }));
  typeError(() => JSON.stringify({ value: 1n }));
  assert(JSON.stringify({ after: true }) === '{"after":true}', "error recovery");
}, true);
console.log("nested, shared, cycle and error recovery passed");

let getters = 0;
let toJSON = 0;
let replacements = 0;
const reentrant = {
  get value() {
    getters++;
    return JSON.stringify({ inner: [1] });
  },
  child: { toJSON() { toJSON++; return { answer: 42 }; } },
};
privateOnly(() => {
  const result = JSON.stringify(reentrant, function (key, value) {
    replacements++;
    assert(typeof this === "object", "replacer receiver");
    if (key === "answer") assert(JSON.stringify({ again: 1 }) === '{"again":1}', "reentrant replacer");
    return value;
  });
  assert(result === '{"value":"{\\"inner\\":[1]}","child":{"answer":42}}', "reentrant JSON");
}, true);
assert(getters === 1 && toJSON === 1 && replacements === 4, "observable callback counts");
const sentinel = {};
function sameError(callback) {
  let caught;
  try { callback(); } catch (error) { caught = error; }
  assert(caught === sentinel, "exception identity");
}
privateOnly(() => {
  sameError(() => JSON.stringify({ get value() { throw sentinel; } }));
  sameError(() => JSON.stringify({ toJSON() { throw sentinel; } }));
  sameError(() => JSON.stringify({ value: 1 }, () => { throw sentinel; }));
}, true);
console.log("reentrant callbacks and exception identities passed");

let pushed;
let own;
let length;
const publicWrites = observed(() => {
  const array = [];
  pushed = array.push(9);
  own = Object.hasOwn(array, "0");
  length = array.length;
});
assert(publicWrites.set === 1 && publicWrites.get === 0, "public push setter count");
assert(pushed === 1 && length === 1 && !own, "public push semantics");
let sparse;
const publicReads = observed(() => { sparse = JSON.stringify(new Array(1)); });
assert(sparse === "[7]" && publicReads.get === 1 && publicReads.set === 0, "public inherited getter");
console.log("public array setter and getter counts: 1 each");
