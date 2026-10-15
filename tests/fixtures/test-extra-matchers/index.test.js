import { test, expect } from "bun:test";
test("own keys, empty keys and holes", () => {
  expect({ "": 1 }).toContainKeys([""]);
  expect({ x: 1, y: 2 }).toContainKeys(["x"]);
  expect({}).toContainKeys([]);
  expect({}).not.toContainAnyKeys([]);
  expect(Object.create({ x: 1 })).not.toContainKey("x");
  expect([,]).not.toContainKeys([,]);
  expect([,]).not.toContainAnyKeys([,]);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("proxy descriptor"); } });
  expect(() => expect(proxy).toContainKeys(["x"])).toThrow("proxy descriptor");
  expect(() => expect({}).toContainKeys("x")).toThrow(TypeError);
});
test("exact non-overlapping repetition counts", () => {
  expect("aaa").toIncludeRepeated("aa", 1);
  expect("aaaa").toIncludeRepeated("aa", 2);
  expect("abc abc").not.toIncludeRepeated("abc", 1);
  expect("abc").toIncludeRepeated("x", 0);
  expect(() => expect("abc").toIncludeRepeated("", 0)).toThrow("non-empty string");
  expect(() => expect("abc").toIncludeRepeated("a", 1.5)).toThrow("second argument");
});
