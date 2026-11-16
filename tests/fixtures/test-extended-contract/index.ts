import { expect } from "bun:test";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function call(received: unknown, name: string, args: unknown[] = [], not = false): unknown {
  const target = not ? expect(received).not : expect(received);
  const matcher: unknown = Reflect.get(target, name);
  check(typeof matcher === "function", `missing ${name}`);
  return Reflect.apply(matcher, target, args);
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected a throw");
}

function message(error: unknown): string {
  check(error instanceof Error, "expected Error");
  return error.message;
}

for (const name of ["pass", "fail"]) {
  const not = name === "pass";
  check(call(undefined, name, [], !not) === undefined, `${name} returns undefined`);
  const verb = not ? "passes" : "fails";
  check(message(thrown(() => call(undefined, name, [], not))).includes(`${verb} by .${name}() assertion`), `${name} default message`);
  check(message(thrown(() => call(1, name, ["custom message"], not))).includes("custom message"), `${name} custom message`);
  for (const value of [1, undefined, null, {}]) {
    check(message(thrown(() => call(1, name, [value], !not))).includes(`Expected message to be a string for '${name}'.`), `${name} validates before negation`);
  }
  let coercions = 0;
  const boxed = new String("boxed message");
  boxed.toString = () => { coercions++; return "boxed message"; };
  check(call(1, name, [boxed], !not) === undefined, `${name} accepts boxed messages`);
  check(coercions === 1, `${name} normalizes boxed messages before the assertion result`);
  check(message(thrown(() => call(1, name, [boxed], not))).includes("boxed message"), `${name} boxed failure message`);
  check(coercions === 2, `${name} coerces each message only once`);
  const sentinel = new Error("message coercion");
  boxed.toString = () => { throw sentinel; };
  check(thrown(() => call(1, name, [boxed], not)) === sentinel, `${name} message coercion identity`);
  check(thrown(() => call(1, name, [boxed], !not)) === sentinel, `${name} successful-path coercion identity`);
}
console.log("PASS pass and fail helpers");

for (const size of [0, 3, 3_000_000_000, 2 ** 32 - 1]) {
  check(call(new Array(size), "toBeArrayOfSize", [size]) === undefined, "array size");
  call(new Array(size), "toBeArrayOfSize", [size + 1], true);
}
for (const value of [null, {}, "three", new Uint8Array(3)]) call(value, "toBeArrayOfSize", [3], true);
for (const args of [[], [undefined], ["3"], [3n], [NaN], [Infinity], [1.5], [-0], [2 ** 51], [-(2 ** 51) - 1]]) {
  check(message(thrown(() => call([], "toBeArrayOfSize", args, true))).includes("toBeArrayOfSize() requires"), "array size validation");
}
for (const size of [-(2 ** 51), 2 ** 51 - 1]) call([], "toBeArrayOfSize", [size], true);
console.log("PASS array size and validation");

for (const value of [0, -0, 2, -2, 2n, -2n, 1n << 100n, -(1n << 100n)]) {
  call(value, "toBeEven");
  call(value, "toBeOdd", [], true);
}
for (const value of [1, -1, 3n, -3n, (1n << 100n) + 1n, -(1n << 100n) - 1n]) {
  call(value, "toBeOdd");
  call(value, "toBeEven", [], true);
}
for (const value of [NaN, Infinity, -Infinity, 0.5, "2", {}, new Number(2)]) {
  call(value, "toBeEven", [], true);
  call(value, "toBeOdd", [], true);
}
console.log("PASS number and bigint parity");

call(" h\te\nl\vl\fo\r ", "toEqualIgnoringWhitespace", ["hello"]);
call("a\u00a0b", "toEqualIgnoringWhitespace", ["ab"], true);
call("a\ufeffb", "toEqualIgnoringWhitespace", ["ab"], true);
call(1, "toEqualIgnoringWhitespace", ["1"], true);
call(new String(" h e l l o "), "toEqualIgnoringWhitespace", [new String("hello")]);
call(String.prototype, "toEqualIgnoringWhitespace", [""]);
call("", "toEqualIgnoringWhitespace", [String.prototype]);
let fakeCoercions = 0;
const fakeString = Object.assign(Object.create(String.prototype), { toString() { fakeCoercions++; return "a"; } });
thrown(() => call(fakeString, "toEqualIgnoringWhitespace", ["a"]));
call(fakeString, "toEqualIgnoringWhitespace", ["a"], true);
thrown(() => call("a", "toEqualIgnoringWhitespace", [fakeString], true));
check(fakeCoercions === 0, "forged string data is never coerced");
for (const args of [[], [undefined], [1]]) {
  check(message(thrown(() => call("hello", "toEqualIgnoringWhitespace", args, true))).includes("toEqualIgnoringWhitespace() requires"), "whitespace validation");
}
console.log("PASS ASCII whitespace comparison");

call("abc abc", "toIncludeRepeated", ["abc", 2]);
call("aaa", "toIncludeRepeated", ["aa", 1]);
call("😘🥳😘", "toIncludeRepeated", ["😘", 2]);
call("abc", "toIncludeRepeated", ["d", 0]);
for (const count of [-0, undefined, null, NaN, Infinity, 1.5]) {
  check(message(thrown(() => call("", "toIncludeRepeated", ["a", count], true))).includes("requires the second argument to be a number"), "count validation");
}
console.log("PASS repeated substring validation");

const form = new FormData();
form.set("a", "b");
for (const value of [new Headers({ a: "b" }), new URLSearchParams("a=b"), form, new Blob(["x"]), new Uint8Array(1), new ArrayBuffer(1)]) {
  check(call(value, "toBeEmpty", [], true) === undefined, "nonempty container");
}
for (const value of [new Headers(), new URLSearchParams(), new FormData(), new Blob(), new Uint8Array(), new ArrayBuffer(0)]) call(value, "toBeEmpty");
const shadowFailure = new Error("shadow container size");
const fullView = new Uint8Array(1);
Object.defineProperty(fullView, "byteLength", { value: 0 });
call(fullView, "toBeEmpty", [], true);
const emptyView = new Uint8Array();
Object.defineProperty(emptyView, "byteLength", { get() { throw shadowFailure; } });
call(emptyView, "toBeEmpty");
const emptyBlob = new Blob();
Object.defineProperty(emptyBlob, "size", { get() { throw shadowFailure; } });
call(emptyBlob, "toBeEmpty");
const fullBlob = new Blob(["x"]);
Object.defineProperty(fullBlob, "size", { value: 0 });
call(fullBlob, "toBeEmpty", [], true);
let visits = 0;
function* values() { visits++; yield 1; visits++; yield 2; visits++; }
const iterator = values();
call(iterator, "toBeEmpty", [], true);
check(visits === 3 && iterator.next().done, "emptiness consumes the full iterable");
const sentinel = new Error("iterator failure");
const callable = () => {};
Object.defineProperty(callable, Symbol.iterator, { value: function* () { throw sentinel; } });
call(callable, "toBeEmpty");
call(Object.create(ArrayBuffer.prototype), "toBeEmpty");
const broken = { *[Symbol.iterator]() { yield 1; throw sentinel; } };
check(thrown(() => call(broken, "toBeEmpty", [], true)) === sentinel, "iterator error identity");
let iteratorReads = 0;
let nextReads = 0;
let steps = 0;
const observedIterator = {
  get next() {
    nextReads++;
    return () => ({ done: steps++ > 0, value: 1 });
  },
};
const observed = {
  get [Symbol.iterator]() {
    iteratorReads++;
    return () => observedIterator;
  },
};
call(observed, "toBeEmpty", [], true);
check(iteratorReads === 2 && nextReads === 1 && steps === 2, "iterator getter and next counts");
let methodReads = 0;
const changing = {
  get [Symbol.iterator]() {
    methodReads++;
    return methodReads === 1 ? function* () { yield 1; } : function* () {};
  },
};
call(changing, "toBeEmpty");
check(methodReads === 2, "uses the iterator acquired after the iterability probe");
await Bun.write("expect-empty.txt", "");
await Bun.write("expect-full.txt", "x");
call(Bun.file("expect-empty.txt"), "toBeEmpty");
call(Bun.file("expect-full.txt"), "toBeEmpty", [], true);
const emptyFile = Bun.file("expect-empty.txt");
Object.defineProperty(emptyFile, "size", { get() { throw shadowFailure; } });
call(emptyFile, "toBeEmpty");
const fullFile = Bun.file("expect-full.txt");
Object.defineProperty(fullFile, "size", { value: 0 });
call(fullFile, "toBeEmpty", [], true);
console.log("PASS container emptiness and iterator errors");
