import { expect } from "bun:test";

function call(name: string, not = false) {
  const target = not ? expect(1).not : expect(1);
  const matcher: unknown = Reflect.get(target, name);
  if (typeof matcher !== "function") throw new Error(`missing matcher ${name}`);
  return Reflect.apply(matcher, target, []);
}

const cases: [string, () => unknown][] = [
  ["inherited registration", () => {
    expect.extend(Object.create({ inherited: () => ({ pass: true }) }));
    call("inherited");
  }],
  ["class registration", () => {
    class Base { classMatcher() { return { pass: true }; } }
    class Derived extends Base {}
    expect.extend(new Derived());
    call("classMatcher");
  }],
  ["invalid registration", () => {
    for (const value of [undefined, null, 42, "value"]) {
      const kind = value === null ? "null" : typeof value;
      expect(() => expect.extend(Object.fromEntries([["invalid", value]]))).toThrow(
        `expect.extend: \`invalid\` is not a valid matcher. Must be a function, is "${kind}"`,
      );
    }
  }],
  ["invalid result diagnostics", () => {
    for (const value of [undefined, 42, {}]) {
      expect.extend(Object.fromEntries([["invalidResult", () => value]]));
      const printed = value === undefined ? "undefined" : value === 42 ? "42" : "{}";
      expect(() => call("invalidResult")).toThrow(`'${printed}' was returned`);
    }
  }],
  ["truthy pass and message coercion", () => {
    expect.extend(Object.fromEntries([["coerce", () => ({
      pass: 42,
      message: () => ({ [Symbol.toPrimitive]() { throw new Error("message coercion"); } }),
    })]]));
    call("coerce");
    expect(() => call("coerce", true)).toThrow("message coercion");
  }],
  ["color context", () => {
    expect.extend({ color() {
      expect(this.utils.RECEIVED_COLOR).toBeFunction();
      expect(this.utils.RECEIVED_COLOR("hello")).toBe('"hello"');
      return { pass: true };
    } });
    call("color");
  }],
  ["async result", async () => {
    expect.extend({ asynchronous: () => Promise.resolve({ pass: true }) });
    await call("asynchronous");
    await expect(async () => await call("asynchronous", true)).toThrow("No message was specified");
  }],
  ["async rejection", async () => {
    expect.extend({ rejecting: () => Promise.reject("extension rejection") });
    let caught: unknown;
    try { await call("rejecting"); } catch (error) { caught = error; }
    expect(caught).toBe("extension rejection");
  }],
];

let failures = 0;
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${String(error)}`);
  }
}
if (failures) throw new Error(`${failures} extension regressions`);
