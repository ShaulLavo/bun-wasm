import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext, runInNewContext } from "node:vm";

const runtime = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const bootstrap = readFileSync(new URL("bootstrap.js", runtime), "utf8");
const definitions = bootstrap.slice(bootstrap.indexOf("  function defineGlobal("), bootstrap.indexOf("  // --- async context"));
const callbackStart = bootstrap.indexOf("  if (installIntlFallback) {");
const callback = bootstrap.slice(callbackStart, bootstrap.indexOf("\n  }", callbackStart) + 4);
const timers = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.timersFactory = ${readFileSync(new URL("fake_timers.ts", runtime), "utf8")}`);
const intl = readFileSync(new URL("intl.js", runtime), "utf8");

function loader(order: "native" | "before" | "after") {
  const context = createContext({ timers, intl, definitions, callback, order, otherIntl: runInNewContext("Intl") });
  runInContext(`
    const internal = { native: {} };
    const originalIntl = Intl;
    const originalPrototype = Intl.DateTimeFormat.prototype;
    const originalGetter = Object.getOwnPropertyDescriptor(originalPrototype, "format").get;
    const originalParts = originalPrototype.formatToParts;
    let loads = 0;
    internal.require = name => {
      if (name !== "intl") throw new Error("Unexpected polyfill " + name);
      loads++;
      return (0, eval)(intl)(internal);
    };
    eval(definitions);
    const installIntlFallback = order !== "native";
    eval(callback);
    const beforeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Intl");
    if (order === "before") void Intl;
    internal.fakeTimers = (0, eval)(timers)(internal);
    const coldLoads = loads;
    const coldDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Intl");
    function error(run) {
      try { run(); return "none"; } catch (error) { return error.name + ":" + error.message; }
    }
  `, context);
  return (probe: string): unknown => runInContext(`(() => { ${probe} })()`, context);
}

test("keeps fallback Intl unloaded until its production lazy callback is used", () => {
  const run = loader("after");
  expect(run(`return { loads: coldLoads, accessor: coldDescriptor.get === beforeDescriptor.get };`)).toEqual({ loads: 0, accessor: true });
  expect(run(`
    const first = Intl;
    const second = Intl;
    return { loads, same: first === second, installed: "value" in Object.getOwnPropertyDescriptor(globalThis, "Intl") };
  `)).toEqual({ loads: 1, same: true, installed: true });
});

for (const order of ["native", "before", "after"] as const) {
  test(`${order} Intl installation preserves saved formatters and prototype identity`, () => {
    const run = loader(order);
    expect(run(`
      const namespace = Intl;
      const prototype = namespace.DateTimeFormat.prototype;
      const formatter = new namespace.DateTimeFormat("en-US", {timeZone: "UTC", year: "numeric"});
      const savedFormat = formatter.format;
      const savedParts = formatter.formatToParts;
      const getter = Object.getOwnPropertyDescriptor(prototype, "format").get;
      const parts = prototype.formatToParts;
      const invalidGetter = error(() => getter.call({}));
      const invalidParts = error(() => parts.call({}));
      const distinctInstances = savedFormat !== new namespace.DateTimeFormat("en-US").format;
      internal.fakeTimers.installIntl(namespace);
      internal.fakeTimers.installIntl({DateTimeFormat: namespace.DateTimeFormat});
      const stable = getter === Object.getOwnPropertyDescriptor(prototype, "format").get && parts === prototype.formatToParts && savedFormat === formatter.format;
      const year = value => savedParts.call(formatter, value).find(part => part.type === "year").value;
      internal.fakeTimers.api.setSystemTime(0);
      const epoch = [savedFormat(), savedFormat(undefined), year(), year(undefined)];
      internal.fakeTimers.api.useFakeTimers({now: -1});
      const negative = [savedFormat(), year()];
      const explicit = [savedFormat(946684800000), savedFormat(new Date(946684800000)), year(946684800000), year(new Date(946684800000))];
      const brands = invalidGetter === error(() => getter.call({})) && invalidParts === error(() => parts.call({}));
      internal.fakeTimers.api.useRealTimers();
      const restored = savedFormat() === savedFormat(Date.now()) && year() === year(Date.now());
      const nativeBrands = order !== "native" || invalidGetter === error(() => originalGetter.call({})) && invalidParts === error(() => originalParts.call({}));
      return {loads, stable, distinctInstances, epoch, negative, explicit, brands, restored, nativeBrands};
    `)).toEqual({ loads: order === "native" ? 0 : 1, stable: true, distinctInstances: true, epoch: ["1970", "1970", "1970", "1970"], negative: ["1969", "1969"], explicit: ["2000", "2000", "2000", "2000"], brands: true, restored: true, nativeBrands: true });
  });
}

test("reinstalling a shared prototype leaves a data-valued format alone", () => {
  const run = loader("native");
  expect(run(`
    const method = function(value) { return value; };
    const prototype = {format: method, formatToParts(value) { return value; }};
    const namespace = {DateTimeFormat: function() {}};
    namespace.DateTimeFormat.prototype = prototype;
    internal.fakeTimers.installIntl(namespace);
    const parts = prototype.formatToParts;
    internal.fakeTimers.installIntl({DateTimeFormat: namespace.DateTimeFormat});
    internal.fakeTimers.api.setSystemTime(0);
    return {formatUnchanged: prototype.format === method, partsStable: prototype.formatToParts === parts, clock: prototype.formatToParts()};
  `)).toEqual({ formatUnchanged: true, partsStable: true, clock: 0 });
});

for (const order of ["native", "after"] as const) {
  test(`${order} Intl replacements retain the existing unpatched replacement behavior`, () => {
    const run = loader(order);
    expect(run(`
      const namespace = Intl;
      const constructor = namespace.DateTimeFormat;
      const formatter = new constructor("en-US", {timeZone: "UTC", year: "numeric"});
      const saved = formatter.format;
      const parts = formatter.formatToParts;
      Intl = otherIntl;
      internal.fakeTimers.api.setSystemTime(0);
      const globalUnpatched = new Intl.DateTimeFormat("en-US", {timeZone: "UTC", year: "numeric"}).format() !== "1970";
      Intl = namespace;
      Intl.DateTimeFormat = otherIntl.DateTimeFormat;
      const constructorUnpatched = new Intl.DateTimeFormat("en-US", {timeZone: "UTC", year: "numeric"}).format() !== "1970";
      const savedPatched = saved() === "1970" && parts.call(formatter).find(part => part.type === "year").value === "1970";
      Intl.DateTimeFormat = constructor;
      internal.fakeTimers.api.useRealTimers();
      return {globalUnpatched, constructorUnpatched, savedPatched};
    `)).toEqual({ globalUnpatched: true, constructorUnpatched: true, savedPatched: true });
  });
}
