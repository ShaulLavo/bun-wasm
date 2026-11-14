// Deliberate ECMAScript inputs shared by Node and the bare native engine.
const nativeExec = RegExp.prototype.exec;
const nativeTest = RegExp.prototype.test;
const traces: unknown[] = [];

function testInput(receiver: unknown, value: unknown): boolean {
  return Reflect.apply(nativeTest, receiver, [value]);
}

function setIndex(re: RegExp, value: unknown): void {
  Object.defineProperty(re, "lastIndex", { value, writable: true });
}

function trace(label: string, run: (events: unknown[]) => unknown): void {
  const events: unknown[] = [];
  try {
    traces.push([label, run(events), events]);
  } catch (error) {
    traces.push([label, error instanceof Error ? error.name : String(error), events]);
  }
}

function input(events: unknown[]): object {
  return { toString() { events.push("input.toString"); return "baab"; } };
}

function custom(result: unknown): void {
  trace(`custom-${String(result)}`, events => {
    const receiver = { exec(value: unknown) { events.push(["exec", this === receiver, typeof value]); return result; } };
    return testInput(receiver, input(events));
  });
}

for (const result of [null, {}, [], true, false, 1, "x", undefined]) custom(result);

trace("custom-getter", events => {
  const receiver = { get exec() { events.push("get exec"); return function (this: object, value: unknown) { events.push(["call", this === receiver, typeof value]); return {}; }; } };
  return testInput(receiver, input(events));
});
trace("throwing-getter", events => testInput({ get exec() { events.push("get exec"); throw new RangeError("getter"); } }, input(events)));
trace("throwing-input-custom", events => testInput({ exec() { events.push("exec"); return {}; } }, { toString() { events.push("input.toString"); throw new URIError("input"); } }));

function state(flags: string, value: unknown): void {
  trace(`state-${flags}-${String(value)}`, events => {
    const re = new RegExp("a", flags);
    setIndex(re, value);
    const first = testInput(re, input(events));
    const index = re.lastIndex;
    const second = re.test("x");
    return [first, index, second, re.lastIndex];
  });
}

for (const flags of ["", "g", "y", "gy"]) {
  for (const value of [-1, NaN, Infinity, 0, 1, 3, 100]) state(flags, value);
  trace(`lastIndex-object-${flags}`, events => {
    const re = new RegExp("a", flags);
    setIndex(re, { valueOf() { events.push("lastIndex.valueOf"); return 1; } });
    const result = testInput(re, input(events));
    return [result, typeof re.lastIndex === "object" ? "object" : re.lastIndex];
  });
  trace(`lastIndex-throw-${flags}`, events => {
    const re = new RegExp("a", flags);
    setIndex(re, { valueOf() { events.push("lastIndex.valueOf"); throw new RangeError("index"); } });
    return testInput(re, input(events));
  });
}

function readonlyIndex(flags: string, value: number, text: string): void {
  trace(`readonly-${flags}-${value}-${text}`, () => {
    const re = new RegExp("a", flags);
    Object.defineProperty(re, "lastIndex", { value, writable: false });
    return [re.test(text), re.lastIndex];
  });
}
for (const flags of ["", "g", "y"]) {
  readonlyIndex(flags, 0, "a");
  readonlyIndex(flags, 0, "x");
  readonlyIndex(flags, 8, "a");
}

function noncallable(exec: unknown): void {
  trace(`noncallable-${String(exec)}`, events => {
    const re = /a/g;
    Object.defineProperty(re, "exec", { get() { events.push("get exec"); return exec; } });
    return [testInput(re, input(events)), re.lastIndex];
  });
}
for (const exec of [null, undefined, 1, {}]) noncallable(exec);

trace("getter-native", events => {
  const re = /(?<a>a)(b)?/dg;
  Object.defineProperty(re, "exec", { get() { events.push("get exec"); return nativeExec; } });
  return [testInput(re, input(events)), re.lastIndex];
});
trace("proxy-native-function", events => {
  const re = /a/;
  re.exec = new Proxy(nativeExec, { apply(target, receiver, args) { events.push("proxy.apply"); return Reflect.apply(target, receiver, args); } });
  return testInput(re, input(events));
});
trace("bound-native-function", events => {
  const re = /a/g;
  re.exec = nativeExec.bind(re);
  return [testInput(re, input(events)), re.lastIndex];
});

const matches: [string, string, string][] = [
  ["(?<a>a)(b)?", "dg", "aa"], ["(a+)\\1", "g", "baaaab"],
  ["(?<name>𐀀)(a)?", "duy", "𐀀"], ["(?<=a)b", "g", "ab"],
  ["(a|ab)+c", "", "ababc"], ["[\\p{Letter}&&[^a]]+", "v", "β"],
  ["(?:)", "gu", "𐀀"], ["a(?=b)", "y", "ab"],
];
for (const [pattern, flags, text] of matches) {
  trace(`match-${pattern}-${flags}`, () => {
    const re = new RegExp(pattern, flags);
    return [re.test(text), re.lastIndex, re.test(text), re.lastIndex];
  });
}

trace("lastIndex-reentry", events => {
  const re = /a/g;
  setIndex(re, { valueOf() { events.push(["nested", /b/.test("b")]); return 1; } });
  return [testInput(re, input(events)), re.lastIndex];
});
trace("input-reentry", events => {
  const re = /a/g;
  const value = { toString() { events.push(["nested", re.test("a"), re.lastIndex]); return "ba"; } };
  return [testInput(re, value), re.lastIndex];
});
trace("exec-reentry", events => {
  const re = /a/g;
  Object.defineProperty(re, "exec", { get() { events.push(["nested", /b/.test("b")]); return nativeExec; } });
  return [re.test("ba"), re.lastIndex];
});
trace("symbol-input", () => testInput(/a/, Symbol("a")));
trace("native-return-still-array", () => {
  const re = /(?<a>a)(b)?/d;
  const result = re.exec("a");
  return [Array.isArray(result), result?.length, result?.groups, result?.indices, re.test("a")];
});

function invalid(receiver: unknown, index: number): void {
  trace(`receiver-${index}`, events => testInput(receiver, input(events)));
}
for (const [index, receiver] of [null, undefined, 1, "a", {}, RegExp.prototype, new Proxy(/a/, {})].entries()) invalid(receiver, index);
console.log(JSON.stringify(traces));
