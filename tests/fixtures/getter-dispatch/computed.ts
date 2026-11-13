import { computedReaderSource, computedWidths } from "./computed-widths";

type ComputedRead = (base: unknown, key: unknown) => unknown;

export function computedGetterSemantics(check: (name: string, actual: unknown, expected: unknown) => void, thrown: (action: () => unknown) => string): void {
  const order: string[] = [];
  const holder = { get value() { order.push("get"); return this; } };
  const read = new Function("base", "key", "return base[key];");
  const key = { toString() { order.push("key"); return "value"; } };
  check("computed coercion receiver", read(holder, key), holder);
  check("computed coercion order", order.join(","), "key,get");
  order.length = 0;
  const badKey = { toString() { order.push("bad key"); throw new SyntaxError("key"); } };
  check("computed throwing key", thrown(() => read(holder, badKey)), "SyntaxError");
  check("computed throwing key skips getter", order.join(","), "bad key");
  order.length = 0;
  check("computed null before key coercion", thrown(() => read(null, badKey)), "TypeError");
  check("computed undefined before key coercion", thrown(() => read(undefined, badKey)), "TypeError");
  check("computed nullish key not coerced", order.length, 0);
  const symbol = Symbol("computed");
  const indexed = { get 0() { return this; }, get [symbol]() { return this; } };
  check("computed symbol receiver", read(indexed, symbol), indexed);
  check("computed string index receiver", read(indexed, "0"), indexed);
  check("computed numeric index receiver", read(indexed, 0), indexed);
  check("computed array negative one miss", read([], -1), undefined);
  typedArrayReads(check, read);
  primitiveReads(check, read);
  fallbackReads(check, thrown, read);
  exceptionReads(check, read);
  aliasReads(check);
  widthReads(check, thrown);
  alternatingReads(check, read);
}

function typedArrayReads(check: (name: string, actual: unknown, expected: unknown) => void, read: ComputedRead): void {
  const prototype = Object.create(Uint8Array.prototype, { 3: { get() { return "prototype"; } } });
  const array = new Uint8Array(1);
  Object.setPrototypeOf(array, prototype);
  check("computed typed array string out of bounds", read(array, "3"), undefined);
  check("computed typed array numeric out of bounds", read(array, 3), undefined);
}

function primitiveReads(check: (name: string, actual: unknown, expected: unknown) => void, read: ComputedRead): void {
  const strict = new Function('"use strict"; return this;');
  const sloppy = new Function("return typeof this;");
  const key = "computedPrimitiveReceiver";
  for (const [prototype, sample] of [[String.prototype, "text"], [Number.prototype, 7]] as const) {
    Object.defineProperty(prototype, key, { get: strict, configurable: true });
    check(`computed strict ${typeof sample} receiver`, read(sample, key), sample);
    Object.defineProperty(prototype, key, { get: sloppy, configurable: true });
    check(`computed sloppy ${typeof sample} receiver`, read(sample, key), "object");
    Reflect.deleteProperty(prototype, key);
  }
}

function fallbackReads(check: (name: string, actual: unknown, expected: unknown) => void, thrown: (action: () => unknown) => string, read: ComputedRead): void {
  const holder = {};
  Object.defineProperty(holder, "bound", { get: function() { return this; }.bind(holder) });
  Object.defineProperty(holder, "proxy", { get: new Proxy(function() { return this; }, {}) });
  check("computed host accessor", read(new Map([[1, 2]]), "size"), 1);
  check("computed host accessor wrong receiver", thrown(() => read(Map.prototype, "size")), "TypeError");
  check("computed bound getter", read(holder, "bound"), holder);
  check("computed callable proxy getter", read(holder, "proxy"), holder);
  const target = { get value() { return this; } };
  const proxy = new Proxy(target, {});
  check("computed proxy base receiver", read(proxy, "value"), proxy);
  const revoked = Proxy.revocable(target, {});
  revoked.revoke();
  check("computed revoked proxy", thrown(() => read(revoked.proxy, "value")), "TypeError");
}

function exceptionReads(check: (name: string, actual: unknown, expected: unknown) => void, read: ComputedRead): void {
  const holder = { get computedFailure() { throw new Error("computed failure"); } };
  const order: string[] = [];
  try { computedThrowSite(holder); } catch (error) {
    const stack = error instanceof Error ? error.stack ?? "" : "";
    check("computed throw names read site", /computedThrowSite.*:\d+:\d+/.test(stack), true);
    order.push("catch");
  } finally { order.push("finally"); }
  check("computed throw catch and finally", order.join(","), "catch,finally");
  check("computed recovery after throw", read({ get value() { return 9; } }, "value"), 9);
}

function computedThrowSite(holder: Record<string, unknown>): unknown {
  const key = ["computedFailure"][0]!;
  return holder[key];
}

function aliasReads(check: (name: string, actual: unknown, expected: unknown) => void): void {
  const holder = { get value() { return this; } };
  check("computed base destination alias", new Function("base", "key", "base = base[key]; return base;")(holder, "value"), holder);
  check("computed key destination alias", new Function("base", "key", "key = base[key]; return key;")(holder, "value"), holder);
}

function widthReads(check: (name: string, actual: unknown, expected: unknown) => void, thrown: (action: () => unknown) => string): void {
  const max = Number(process.env.GETTER_DISPATCH_WIDE_LOCALS ?? 2000);
  for (const { name, count } of computedWidths) {
    const locals = Math.min(count, max);
    const read = new Function(`return (${computedReaderSource(locals, name)});`)();
    check(`${name} getter value and live locals`, read({ get value() { return 17; } }, "value"), (locals * (locals - 1)) / 2 + 17);
    check(`${name} getter failure`, thrown(() => read({ get value() { throw new SyntaxError("wide"); } }, "value")), "SyntaxError");
    check(`${name} recovery`, read({ get value() { return 17; } }, "value"), (locals * (locals - 1)) / 2 + 17);
  }
}

function alternatingReads(check: (name: string, actual: unknown, expected: unknown) => void, read: ComputedRead): void {
  const data = { value: 1 };
  const getter = { get value() { return 2; } };
  let sum = 0;
  for (let i = 0; i < 20000; i++) {
    const value = read(i % 2 ? data : getter, "value");
    if (typeof value !== "number") throw new Error("Expected a numeric getter result");
    sum += value;
  }
  check("computed hot data and getter site", sum, 30000);
}
