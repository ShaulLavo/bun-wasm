import * as url from "node:url";

function attempt(label: string, run: () => unknown) {
  try { console.log(label, JSON.stringify(run())); }
  catch (error) {
    if (typeof error !== "object" || error === null || !("name" in error) || !("message" in error)) throw error;
    console.log(label, "throws", error.name, "code" in error ? error.code : undefined, error.message);
  }
}

function params(init: unknown): URLSearchParams {
  return Reflect.construct(URLSearchParams, [init]);
}

for (const [label, value] of [["high", "\ud800"], ["low", "\udfff"], ["mixed", "\ud800A\udfff😀"], ["pair", "😀"]]) {
  attempt(`record ${label}`, () => { const p = params({ [value]: value }); return [Array.from(p), p.toString()]; });
  attempt(`query ${label}`, () => url.format({ query: { a: value } }));
}
attempt("record converted key collision", () => Array.from(params({ "\ud800": "first", "\udfff": "last" })));
attempt("sequence repeated keys", () => Array.from(params([["\ud800", "first"], ["\udfff", "last"]])));
attempt("record symbol value", () => params({ a: Symbol("x") }));
attempt("sequence symbol key", () => params([[Symbol("x"), "1"]]));
attempt("query symbol value", () => url.format({ query: { a: Symbol("x") } }));
attempt("query flat array", () => url.format({ query: [1, 2] }));
attempt("flat array", () => params([1, 2]));
attempt("string pair", () => params(["ab"]));
attempt("short pair", () => params([["a"]]));
attempt("long pair", () => params([["a", "b", "c"]]));
attempt("URL prototype argument", () => url.fileURLToPath(Object.create(URL.prototype)));

const log: string[] = [];
const sentinel = new RangeError("sentinel");
function value(label: string, fail = false) {
  return { [Symbol.toPrimitive](hint: string) {
    log.push(`${label} ${hint}`);
    if (fail) throw sentinel;
    return label;
  } };
}
function sequence(items: readonly unknown[], label: string) {
  return { [Symbol.iterator]() {
    log.push(`${label} iterator`);
    let index = 0;
    return {
      next() { log.push(`${label} next ${index}`); return index < items.length ? { value: items[index++], done: false } : { done: true }; },
      return() { log.push(`${label} close`); return { done: true }; },
    };
  } };
}
attempt("record getter order", () => {
  const p = params({ get a() { log.push("get a"); return value("a"); }, get b() { log.push("get b"); return value("b"); } });
  return [p.toString(), log.splice(0)];
});
attempt("iterator getter once", () => {
  const p = params({ get [Symbol.iterator]() { log.push("get iterator"); return function* () { log.push("call iterator"); yield ["a", "1"]; }; } });
  return [p.toString(), log.splice(0)];
});
attempt("sequence conversion order", () => {
  const p = params(sequence([sequence([value("key"), value("value")], "pair")], "outer"));
  return [p.toString(), log.splice(0)];
});
attempt("conversion throw identity", () => {
  let same = false;
  try { params(sequence([sequence([value("key"), value("value", true)], "pair")], "outer")); }
  catch (error) { same = error === sentinel; }
  return [same, log.splice(0)];
});
attempt("getter throw identity", () => {
  try { params({ get a() { throw sentinel; } }); }
  catch (error) { return error === sentinel; }
  return false;
});
attempt("bad pair consumes sequence first", () => {
  let message = "";
  try { params(sequence([sequence([value("a"), value("b"), value("c")], "pair")], "outer")); }
  catch (error) { if (typeof error !== "object" || error === null || !("name" in error) || !("message" in error)) throw error; message = error.message; }
  return [message, log.splice(0)];
});
for (const method of ["append", "set", "get", "getAll", "has", "delete"] as const) {
  attempt(`method ${method} coercion`, () => {
    const p = params("key=old&key=other");
    const result = Reflect.apply(p[method], p, [value("key"), value("value")]);
    return [result, p.toString(), log.splice(0)];
  });
  attempt(`method ${method} symbol`, () => Reflect.apply(params("a=1" )[method], params("a=1"), [Symbol("x"), "1"]));
}
attempt("method scalar replacement", () => {
  const p = params("");
  p.append("\ud800", "\udfff");
  const found = [p.get("\udfff"), p.has("\udfff", "\ud800")];
  p.set("\udfff", "😀");
  return [found, Array.from(p), p.toString()];
});

for (const method of ["get", "getAll", "has", "delete", "set"] as const) {
  attempt(`invalid receiver ${method}`, () => {
    const args = method === "get" || method === "getAll" ? [value("key", true)] : ["key", value("value", true)];
    try { Reflect.apply(URLSearchParams.prototype[method], {}, args); }
    catch (error) { return [typeof error === "object" && error !== null && "name" in error ? error.name : undefined, error === sentinel, log.splice(0)]; }
    return ["no error", false, log.splice(0)];
  });
  attempt(`valid receiver ${method} throw identity`, () => {
    const p = params("key=old&key=other");
    const args = method === "get" || method === "getAll" ? [value("key", true)] : [value("key"), value("value", true)];
    try { Reflect.apply(p[method], p, args); }
    catch (error) { return [error === sentinel, p.toString(), log.splice(0)]; }
    return [false, p.toString(), log.splice(0)];
  });
}
