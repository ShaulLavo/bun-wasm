import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Frame { name: string; file: string; line: number; column: number }
type Reader = (error: unknown, raw: unknown, excludeSelfHosted: boolean) => unknown;
const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/inspect.js", import.meta.url), "utf8");
const stackTrace = readFileSync(new URL("../crates/bunwasm-runtime/src/js/stack_trace.ts", import.meta.url), "utf8");
const stackFactory = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.stackFactory = ${stackTrace};`);

interface CallSite { getFileName(): string; getLineNumber(): number; getColumnNumber(): number }
interface RuntimeError { stack: unknown }
interface StackRuntime {
  Error: {
    new(): RuntimeError;
    prepareStackTrace?: (this: unknown, error: object, sites: CallSite[]) => unknown;
    captureStackTrace(target: object): void;
  };
  mappedCallSites: WeakSet<object>;
}

function stackRuntime(reader?: Reader, engine = "spidermonkey"): StackRuntime {
  return runInNewContext(`
    const raw = "capture@/encoded%2500.ts:1:2";
    class RuntimeError {}
    Object.defineProperty(RuntimeError.prototype, "stack", {
      configurable: true, get() { return raw; }, set(value) { Object.defineProperty(this, "stack", { value, configurable: true }); },
    });
    RuntimeError.captureStackTrace = target => Object.defineProperty(target, "stack", { value: raw, configurable: true });
    globalThis.Error = RuntimeError;
    globalThis[Symbol.for("bunwasm.internal.spidermonkey.errorFrames")] = reader;
    const inspectFactory = (${source});
    ${stackFactory}
    const internal = {
      native: { engine, preparedSourceName: () => undefined },
      mappedCallSites: new WeakSet(),
      mapPosition: () => [7, 9],
      defineHidden: (target, methods) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(methods)),
      require: () => inspect,
    };
    const inspect = inspectFactory(internal);
    stackFactory(internal);
    ({ Error: RuntimeError, mappedCallSites: internal.mappedCallSites });
  `, { reader, engine });
}

function inspector(engine: string, reader?: Reader, hooks: object = {}) {
  const factory: (internal: object) => { errorFrames(error: unknown, raw: unknown): Frame[] } = runInNewContext(
    'globalThis[Symbol.for("bunwasm.internal.spidermonkey.errorFrames")] = reader;\n' + source,
    { reader },
  );
  return factory({ native: { engine, preparedSourceName: () => undefined }, ...hooks });
}

test("SpiderMonkey CallSite frames use decoded native identities without reading stack again", () => {
  const error = Object.defineProperty({}, "stack", { get() { throw new Error("recursive stack read"); } });
  const raw = "raw@/encoded%2500.ts:1:2";
  const files = ["%00", "/virtual\0%25.ts", "/literal%00%25-雪.ts", "/line\nbreak.ts"];
  const mappings: unknown[][] = [];
  const stack = inspector("spidermonkey", (target, text, exclude) => {
    expect(target).toBe(error);
    expect(text).toBe(raw);
    expect(exclude).toBe(true);
    return files.map(file => ({ name: "capture", file, line: 1, column: 2 }));
  }, { mapPosition: (...args: unknown[]) => { mappings.push(args); return [7, 9]; } });
  expect(stack.errorFrames(error, raw)).toEqual(files.map(file => ({ name: "capture", file, line: 7, column: 9 })));
  expect(mappings).toEqual(files.map(file => [file, 1, 2]));
});

test("an empty native trace stays empty instead of reviving raw frames", () => {
  expect(inspector("spidermonkey", () => []).errorFrames({}, "raw@/raw.ts:1:2")).toEqual([]);
});

for (const [name, reader] of [
  ["absent", undefined],
  ["unavailable", () => undefined],
  ["throws", () => { throw new Error("metadata unavailable"); }],
] satisfies [string, Reader | undefined][]) {
  test(`SpiderMonkey preserves raw fallback when native metadata ${name}`, () => {
    expect(inspector("spidermonkey", reader).errorFrames({}, "capture@/literal%00.ts:3:4"))
      .toEqual([{ name: "capture", file: "/literal%00.ts", line: 3, column: 4 }]);
  });
}

for (const engine of ["quickjs", "jsc", "host"]) {
  test(`${engine} frame parsing does not call SpiderMonkey metadata`, () => {
    let calls = 0;
    const stack = inspector(engine, () => { calls++; return []; });
    expect(stack.errorFrames({}, "capture@/literal%00.ts:3:4"))
      .toEqual([{ name: "capture", file: "/literal%00.ts", line: 3, column: 4 }]);
    expect(calls).toBe(0);
  });
}

test("ordinary SpiderMonkey formatters receive decoded, mapped CallSites lazily with their Error identity", () => {
  const files = ["%00", "/virtual\0%25.ts", "/literal%00%25-雪.ts", "/line\nbreak.ts"];
  let reads = 0;
  const runtime = stackRuntime((target, raw, exclude) => {
    reads++;
    expect(target).toBe(error);
    expect(raw).toBe("capture@/encoded%2500.ts:1:2");
    expect(exclude).toBe(true);
    return files.map(file => ({ name: "capture", file, line: 1, column: 2 }));
  });
  const error = new runtime.Error();
  let calls = 0;
  const sentinel = {};
  runtime.Error.prepareStackTrace = function (target, sites) {
    calls++;
    expect(this).toBe(runtime.Error);
    expect(target).toBe(error);
    expect(sites.map(site => [site.getFileName(), site.getLineNumber(), site.getColumnNumber()]))
      .toEqual(files.map(file => [file, 7, 9]));
    expect(sites.every(site => runtime.mappedCallSites.has(site))).toBe(true);
    return sentinel;
  };
  expect([reads, calls]).toEqual([0, 0]);
  expect(error.stack).toBe(sentinel);
  expect(error.stack).toBe(sentinel);
  expect([reads, calls]).toEqual([1, 1]);
});

test("captured SpiderMonkey holders keep empty native traces and formatter identity", () => {
  let reads = 0;
  const runtime = stackRuntime((target, _raw, exclude) => {
    reads++;
    expect(target).toBe(holder);
    expect(exclude).toBe(true);
    return [];
  });
  const holder: RuntimeError = { stack: undefined };
  let calls = 0;
  runtime.Error.prepareStackTrace = (target, sites) => {
    calls++;
    expect(target).toBe(holder);
    expect(sites).toEqual([]);
    return sites;
  };
  runtime.Error.captureStackTrace(holder);
  expect([reads, calls]).toEqual([0, 0]);
  const sites = holder.stack;
  expect(sites).toEqual([]);
  expect(holder.stack).toBe(sites);
  expect([reads, calls]).toEqual([1, 1]);
});

for (const engine of ["spidermonkey", "jsc", "host"]) {
  test(`${engine} custom CallSites retain raw fallback without native metadata`, () => {
    const runtime = stackRuntime(() => undefined, engine);
    const holder: RuntimeError = { stack: undefined };
    runtime.Error.prepareStackTrace = (_target, sites) => sites.map(site => [site.getFileName(), site.getLineNumber(), site.getColumnNumber()]);
    runtime.Error.captureStackTrace(holder);
    expect(holder.stack).toEqual([["/encoded%2500.ts", 7, 9]]);
  });
}
