import { expect, mock } from "bun:test";

export function consumers(matcher: unknown) {
  const fn = mock((value: number) => value);
  fn(1);
  return [
    ["equal", 1, (assertion: ReturnType<typeof expect>) => assertion.toEqual(matcher)],
    ["strict", [1], (assertion: ReturnType<typeof expect>) => assertion.toStrictEqual([matcher])],
    ["object containing", { value: 1 }, (assertion: ReturnType<typeof expect>) => assertion.toEqual(expect.objectContaining({ value: matcher }))],
    ["array containing", [1], (assertion: ReturnType<typeof expect>) => assertion.toEqual(expect.arrayContaining([matcher]))],
    ["object", { value: 1 }, (assertion: ReturnType<typeof expect>) => assertion.toMatchObject({ value: matcher })],
    ["contain", [1], (assertion: ReturnType<typeof expect>) => assertion.toContainEqual(matcher)],
    ["one of", 1, (assertion: ReturnType<typeof expect>) => assertion.toBeOneOf([matcher])],
    ["property", { value: 1 }, (assertion: ReturnType<typeof expect>) => assertion.toHaveProperty("value", matcher)],
    ["throw", () => { throw 1; }, (assertion: ReturnType<typeof expect>) => assertion.toThrow(matcher)],
    ["called", fn, (assertion: ReturnType<typeof expect>) => assertion.toHaveBeenCalledWith(matcher)],
    ["last called", fn, (assertion: ReturnType<typeof expect>) => assertion.toHaveBeenLastCalledWith(matcher)],
    ["nth called", fn, (assertion: ReturnType<typeof expect>) => assertion.toHaveBeenNthCalledWith(1, matcher)],
    ["returned", fn, (assertion: ReturnType<typeof expect>) => assertion.toHaveReturnedWith(matcher)],
    ["last returned", fn, (assertion: ReturnType<typeof expect>) => assertion.toHaveLastReturnedWith(matcher)],
    ["nth returned", fn, (assertion: ReturnType<typeof expect>) => assertion.toHaveNthReturnedWith(1, matcher)],
    ["inline snapshot", { value: 1 }, (assertion: ReturnType<typeof expect>) => assertion.toMatchInlineSnapshot({ value: matcher }, '\n{\n  "value": eventual(),\n}\n')],
    ["file snapshot", { value: 1 }, (assertion: ReturnType<typeof expect>) => assertion.toMatchSnapshot({ value: matcher })],
  ] satisfies [string, unknown, (assertion: ReturnType<typeof expect>) => unknown][];
}

export function assertion(mode: string, value: unknown) {
  if (mode === "resolves") return expect(Promise.resolve(value)).resolves;
  if (mode === "rejects") return expect(Promise.reject(value)).rejects;
  return expect(value);
}

export function matcher() {
  const factory: unknown = Reflect.get(expect, "eventual");
  if (typeof factory !== "function") throw new Error("missing eventual matcher");
  return Reflect.apply(factory, expect, []);
}
