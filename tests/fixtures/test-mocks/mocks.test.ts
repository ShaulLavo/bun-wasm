import { test, expect, mock, spyOn, jest } from "bun:test";
test("called", () => { const f = mock(() => 1); expect(f).toHaveBeenCalled(); });
test("not called", () => { const f = mock(() => 1); f(1); expect(f).not.toHaveBeenCalled(); });
test("times", () => { const f = mock(() => 1); f(); expect(f).toHaveBeenCalledTimes(2); });
test("with", () => { const f = mock(() => 1); f(1, "a"); f(2); expect(f).toHaveBeenCalledWith(3); });
test("with none", () => { const f = jest.fn(); expect(f).toHaveBeenCalledWith(3); });
test("last", () => { const f = mock(() => 1); f(1); f(2, { a: 1 }); expect(f).toHaveBeenLastCalledWith(3); });
test("nth", () => { const f = mock(() => 1); f(1); f(2); expect(f).toHaveBeenNthCalledWith(1, 3); });
test("returned", () => { const f = mock(() => 1); f(); expect(f).toHaveReturnedWith(2); });
test("spy", () => { const o = { m() { return 1; } }; const s = spyOn(o, "m"); expect(o.m).toHaveBeenCalled(); });
test("not a mock", () => { expect(() => {}).toHaveBeenCalled(); });

test("mock basics", () => {
  const fn = mock((a: number, b: number) => a + b);
  expect(fn(1, 2)).toBe(3);
  expect(fn.mock.calls).toEqual([[1, 2]]);
  expect(fn.mock.results).toEqual([{ type: "return", value: 3 }]);
  expect(fn).toHaveBeenCalled();
  expect(fn).toHaveBeenCalledTimes(1);
  expect(fn).toHaveBeenCalledWith(1, 2);
  expect(fn).toHaveBeenLastCalledWith(1, 2);
  expect(fn).toHaveBeenNthCalledWith(1, 1, 2);
  expect(fn).toHaveReturnedWith(3);
  expect(fn).not.toHaveBeenCalledWith(2, 1);
});

test("mock return values", async () => {
  const fn = jest.fn();
  fn.mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValue(9);
  expect([fn(), fn(), fn(), fn()]).toEqual([1, 2, 9, 9]);
  fn.mockImplementationOnce(() => "once").mockImplementation(() => "impl");
  expect([fn(), fn()]).toEqual(["once", "impl"]);
  fn.mockResolvedValueOnce("resolved");
  await expect(fn()).resolves.toBe("resolved");
  fn.mockRejectedValueOnce(new Error("rejected"));
  await expect(fn()).rejects.toThrow("rejected");
  fn.mockClear();
  expect(fn).not.toHaveBeenCalled();
  expect(fn()).toBe("impl");
  fn.mockReset();
  expect(fn()).toBeUndefined();
});

test("mock that throws", () => {
  const thrower = mock(() => {
    throw new Error("nope");
  });
  expect(() => thrower()).toThrow("nope");
  expect(thrower.mock.results[0].type).toBe("throw");
});

test("spyOn", () => {
  const calc = { add: (a: number, b: number) => a + b };
  const spy = spyOn(calc, "add");
  expect(calc.add(2, 3)).toBe(5);
  expect(spy).toHaveBeenCalledWith(2, 3);
  spy.mockImplementation(() => 0);
  expect(calc.add(2, 3)).toBe(0);
  spy.mockRestore();
  expect(calc.add(2, 3)).toBe(5);
  expect(calc.add).not.toBe(spy);
});
