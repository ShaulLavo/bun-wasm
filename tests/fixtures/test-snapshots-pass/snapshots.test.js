import { describe, expect, test } from "bun:test";

describe("snapshots", () => {
  test("inline values", async () => {
    expect("hello").toMatchInlineSnapshot(`"hello"`);
    expect({ z: [3, null], a: true }).toMatchInlineSnapshot(`
      {
        "a": true,
        "z": [
          3,
          null,
        ],
      }
    `);
    await expect(Promise.resolve(42)).resolves.toMatchInlineSnapshot(`42`);
    expect({ text: "line\r\nbreak", 'quote"': "x" }).toMatchInlineSnapshot(`
      {
        "quote\\\"": "x",
        "text": 
      "line
      break"
      ,
      }
    `);
  });

  test("properties and shared counters", () => {
    const value = { id: 42, nested: { name: "bun", keep: true } };
    const matchers = { id: expect.any(Number), nested: { name: expect.any(String) } };
    expect(value).toMatchInlineSnapshot(matchers, `
      {
        "id": Any<Number>,
        "nested": {
          "keep": true,
          "name": Any<String>,
        },
      }
    `);
    expect(value.id).toBe(matchers.id);
    expect(value.nested.name).toBe(matchers.nested.name);
    expect("after inline").toMatchSnapshot();
    expect(value).toMatchSnapshot("with properties");
    expect({ id: 7 }).toMatchSnapshot({ id: expect.any(Number) }, "direct properties");
  });

  test("file values", () => {
    const circular = { value: "cycle" };
    circular.self = circular;
    const values = [
      "backslash \\ backtick ` template ${x}",
      new Map([["first", new Set([1, 2])], ["empty", new Map()]]),
      new Uint8Array([1, 2, 255]),
      new DataView(new Uint8Array([3, 4]).buffer),
      Buffer.from([5, 6]),
      Buffer.alloc(0),
      new Date(0),
      /hello/gi,
      new Error("snapshot"),
      [undefined, -0, NaN, 1n, Symbol("key")],
      circular,
      { [Symbol("key")]: true, z: 1 },
      "controls \0\b\f\v\t",
    ];
    for (const value of values) expect(value).toMatchSnapshot();
  });

  test("duplicate label", () => expect(1).toMatchSnapshot());
  test("duplicate label", () => expect(2).toMatchSnapshot());

  test("error snapshots", async () => {
    const boom = () => { throw new TypeError("cookie validation"); };
    expect(boom).toThrowErrorMatchingInlineSnapshot(`"cookie validation"`);
    expect(() => { throw new Error(""); }).toThrowErrorMatchingInlineSnapshot(`undefined`);
    expect(() => { throw "primitive"; }).toThrowErrorMatchingInlineSnapshot(`undefined`);
    expect(() => { throw undefined; }).toThrowErrorMatchingInlineSnapshot(`undefined`);
    expect(() => { throw { message: "plain object" }; }).toThrowErrorMatchingInlineSnapshot(`undefined`);
    expect(() => new Error("returned")).toThrowErrorMatchingInlineSnapshot(`"returned"`);
    expect(boom).toThrowErrorMatchingSnapshot();
    expect(boom).toThrowErrorMatchingSnapshot("hint");
    await expect(Promise.reject(new Error("rejected"))).rejects.toThrowErrorMatchingInlineSnapshot(`"rejected"`);
    await expect(Promise.resolve(new Error("resolved"))).resolves.toThrowErrorMatchingInlineSnapshot(`"resolved"`);
    await expect(Promise.resolve(boom)).resolves.toThrowErrorMatchingInlineSnapshot(`"cookie validation"`);
    expect(() => expect(() => {}).toThrowErrorMatchingInlineSnapshot(`undefined`)).toThrow("did not throw");
    expect(() => expect(boom).not.toThrowErrorMatchingSnapshot()).toThrow("cannot be used with not");
    expect(() => expect(boom).toThrowErrorMatchingSnapshot({})).toThrow("Expected first argument to be a string");
    expect(() => expect(boom).toThrowErrorMatchingInlineSnapshot("one", "two")).toThrow("Expected zero or one arguments");
  });

  test("errors reject bad snapshots", () => {
    expect(() => expect(1).toMatchInlineSnapshot(`2`)).toThrow();
    expect(() => expect(1).not.toMatchSnapshot()).toThrow("cannot be used with not");
    expect(() => expect(1).toMatchInlineSnapshot({ id: expect.any(Number) }, `1`)).toThrow("must be an object");
    expect(() => expect({ id: "wrong" }).toMatchSnapshot({ id: expect.any(Number) })).toThrow("propertyMatchers");
    expect(() => expect("wrong").toMatchSnapshot("existing mismatch")).toThrow();
    expect(() => expect(1).toMatchSnapshot(undefined)).toThrow("Expected first argument");
  });
});
