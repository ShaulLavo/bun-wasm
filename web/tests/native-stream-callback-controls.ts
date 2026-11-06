type StreamConstructor = typeof ReadableStream | typeof WritableStream | typeof TransformStream;
type StreamName = "ReadableStream" | "WritableStream" | "TransformStream";
type CallbackCase = { name: StreamName; keys: readonly string[] };
const callbackCases: readonly CallbackCase[] = [
  { name: "ReadableStream", keys: ["start", "pull", "cancel"] },
  { name: "WritableStream", keys: ["start", "write", "close", "abort"] },
  { name: "TransformStream", keys: ["start", "transform", "flush", "cancel"] },
];
function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function capture<T extends StreamConstructor>(Ctor: T, sources: WeakMap<object, object>): T {
  return new Proxy(Ctor, { construct(target, args, newTarget) {
    const stream: object = Reflect.construct(target, args, newTarget);
    sources.set(stream, args[0]);
    return stream;
  } });
}
function fixture(sources: WeakMap<object, object>, name: StreamName, key: string) {
  let value: unknown;
  let throwing = false;
  let controller: unknown;
  let calls = 0;
  const source = {
    start(input: unknown) { controller = input; },
    [key](this: object, input: unknown) {
      invariant(this === source, `${name}.${key} receiver changed`);
      if (key === "start") controller = input;
      calls++;
      if (throwing) throw value;
      return value;
    },
  };
  const stream: object = Reflect.construct(globalThis[name], [source, { highWaterMark: 0 }]);
  const dictionary = sources.get(stream);
  invariant(dictionary, "native dictionary was not captured");
  const callback: unknown = Reflect.get(dictionary, key);
  invariant(typeof callback === "function", `missing ${name}.${key}`);
  return {
    invoke(result: unknown, fail = false) {
      value = result;
      throwing = fail;
      const before = calls;
      try { return Reflect.apply(callback, dictionary, [controller]); }
      finally { invariant(calls === before + 1, `${name}.${key} call count changed`); }
    },
  };
}
async function rejected(result: unknown, reason: unknown) {
  let failed = false;
  try { await result; }
  catch (error) { failed = true; invariant(Object.is(error, reason), "rejection identity changed"); }
  invariant(failed, "expected rejection");
}
function synchronous(own: ReturnType<typeof fixture>, label: string) {
  for (const value of [undefined, null, false, 0, "", NaN, 7, "value", Symbol("sync")]) {
    invariant(Object.is(own.invoke(value), value), `${label} manufactured a promise for ${String(value)}`);
  }
}
async function thrown(own: ReturnType<typeof fixture>, key: string) {
  for (const reason of [undefined, null, false, 0, "", NaN, { marker: "throw" }]) {
    if (key !== "start") { await rejected(own.invoke(reason, true), reason); continue; }
    let failed = false;
    try { own.invoke(reason, true); }
    catch (error) { failed = true; invariant(Object.is(error, reason), "start throw identity changed"); }
    invariant(failed, "start did not throw synchronously");
  }
}
async function asynchronous(own: ReturnType<typeof fixture>) {
  let reads = 0, calls = 0;
  const events: string[] = [];
  const value = { get then() {
    reads++;
    events.push("get");
    return function (this: unknown, resolve: (value: unknown) => void) {
      invariant(this === value, "then receiver changed");
      calls++;
      events.push("call");
      resolve(undefined);
    };
  } };
  const result = own.invoke(value);
  events.push("returned");
  invariant(reads === 1 && calls === 0, "then getter/call timing changed");
  await result;
  invariant(reads === 1 && Number(calls) === 1, "then getter/call repeated");
  invariant(events.join(",") === "get,returned,call", "then job ordering changed");
  const pending = Promise.withResolvers<void>();
  invariant(own.invoke(pending.promise) === pending.promise, "native promise identity changed");
  pending.resolve();
  await pending.promise;
  for (const reason of [undefined, null, false, 0, "", { marker: "reject" }]) {
    await rejected(own.invoke(Promise.reject(reason)), reason);
    await rejected(own.invoke({ get then() { throw reason; } }), reason);
  }
  let nonCallableReads = 0;
  await own.invoke({ get then() { nonCallableReads++; return 0; } });
  invariant(nonCallableReads === 1, "non-callable then getter repeated");
}

async function checkCallback(own: ReturnType<typeof fixture>, key: string, label: string, syncOnly: boolean) {
  if (syncOnly) { synchronous(own, label); return; }
  await thrown(own, key);
  await asynchronous(own);
}

export async function checkNativeStreamCallbacks(install: () => () => void, syncOnly = false) {
  const sources = new WeakMap<object, object>();
  globalThis.ReadableStream = capture(ReadableStream, sources);
  globalThis.WritableStream = capture(WritableStream, sources);
  globalThis.TransformStream = capture(TransformStream, sources);
  const dispose = install();
  const rows: string[] = [];
  try {
    const cases = callbackCases.flatMap(entry => entry.keys.map(key => ({ name: entry.name, key })));
    for (const { name, key } of cases) {
      const own = fixture(sources, name, key);
      await checkCallback(own, key, `${name}.${key}`, syncOnly);
      rows.push(`${name}.${key}`);
    }
  } finally { dispose(); }
  return rows;
}
