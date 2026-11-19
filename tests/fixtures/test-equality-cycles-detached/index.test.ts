import { expect, test } from "bun:test";

test("a cycle must come back to the same pair", () => {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  a.a1 = a;
  b.a1 = { a1: a };
  expect(a).not.toEqual(b);
  expect(b).not.toEqual(a);

  const c: Record<string, unknown> = {};
  c.x = { y: c };
  const d: Record<string, unknown> = {};
  const dx: Record<string, unknown> = {};
  d.x = dx;
  dx.y = dx;
  expect(c).not.toEqual(d);
  expect(d).not.toEqual(c);

  const e: Record<string, unknown> = {};
  e.self = e;
  const g: Record<string, unknown> = {};
  g.self = g;
  expect(e).toEqual(g);
  expect({ inner: e }).toEqual({ inner: g });
});

test("a detached ArrayBuffer equals no other buffer", () => {
  function detached() {
    const buffer = new ArrayBuffer(4);
    buffer.transfer();
    return buffer;
  }
  expect(detached()).not.toEqual(new ArrayBuffer(0));
  expect(detached()).not.toEqual(detached());
  expect(detached()).not.toStrictEqual(new ArrayBuffer(0));
  expect({ x: detached() }).not.toEqual({ x: new ArrayBuffer(0) });
  const same = detached();
  expect(same).toEqual(same);
  expect(new ArrayBuffer(0)).toEqual(new ArrayBuffer(0));
});
