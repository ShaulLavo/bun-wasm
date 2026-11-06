type DictionaryName = "ReadableStream" | "WritableStream" | "TransformStream";
type DictionaryCase = { name: DictionaryName; fields: readonly string[]; methods: readonly string[] };
const dictionaries: readonly DictionaryCase[] = [
  { name: "ReadableStream", fields: ["autoAllocateChunkSize", "cancel", "pull", "start", "type"], methods: ["cancel", "pull", "start"] },
  { name: "WritableStream", fields: ["abort", "close", "start", "type", "write"], methods: ["abort", "close", "start", "write"] },
  { name: "TransformStream", fields: ["cancel", "flush", "readableType", "start", "transform", "writableType"], methods: ["cancel", "flush", "start", "transform"] },
];
function dictionaryInvariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function conversionControl(entry: DictionaryCase, fault: string, value: unknown, throws: boolean, inherited: boolean, native: boolean, missing = false) {
  const trace: string[] = [];
  const source = {};
  const properties = inherited ? {} : source;
  const get = (key: string) => function (this: object) {
    dictionaryInvariant(this === source, `${entry.name}.${key} getter receiver`);
    trace.push(key);
    if (key !== fault) return entry.methods.includes(key) ? () => {} : undefined;
    if (throws) throw value;
    // The completion bridge has always supplied a no-op for undefined start.
    // Compare native conversion under that existing policy, not a new policy.
    return native && key === "start" && value === undefined ? () => {} : value;
  };
  const fields = entry.name === "ReadableStream" ? entry.fields : entry.methods.concat(entry.fields.filter(key => !entry.methods.includes(key) && key === fault));
  for (const key of fields.filter(key => !missing || key !== fault)) Object.defineProperty(properties, key, { get: get(key) });
  if (inherited) Object.setPrototypeOf(source, properties);
  Object.freeze(source);
  const strategy = { get size() { trace.push("size"); return undefined; }, get highWaterMark() { trace.push("highWaterMark"); return 0; } };
  let error = "none", identity = false;
  try { Reflect.construct(globalThis[entry.name], [source, strategy, strategy]); }
  catch (reason) { error = reason instanceof Error ? reason.name : typeof reason; identity = Object.is(value, reason); }
  return { trace, error, identity };
}
export function dictionaryConversions(native = false) {
  const rows: object[] = [];
  for (const entry of dictionaries) appendConversions(rows, entry, native);
  for (const first of [undefined, "bytes"]) rows.push(changingReadableType(first));
  return rows;
}
function appendConversions(rows: object[], entry: DictionaryCase, native: boolean) {
  const probes: { key: string; value: unknown; throws: boolean }[] = entry.fields.flatMap(key => [undefined, null, false, 0, "invalid", () => {}].map(value => ({ key, value, throws: false })));
  const faults = entry.fields.flatMap(key => [undefined, null, false, 0, "", NaN, { marker: key }].map(value => ({ key, value, throws: true })));
  for (const { key, value, throws } of probes.concat(faults)) {
    rows.push({ name: entry.name, key, value: String(value), throws, own: conversionControl(entry, key, value, throws, false, native), inherited: conversionControl(entry, key, value, throws, true, native) });
  }
  for (const key of entry.fields) rows.push({ name: entry.name, key, missing: true, own: conversionControl(entry, key, undefined, false, false, native, true), inherited: conversionControl(entry, key, undefined, false, true, native, true) });
  for (const input of [undefined, null, 0, false, "invalid", Symbol("source"), () => {}]) {
    try { Reflect.construct(globalThis[entry.name], [input]); rows.push({ invalid: "accepted" }); }
    catch (error) { rows.push({ invalid: error instanceof Error ? error.name : typeof error }); }
  }
}
function changingReadableType(first: string | undefined) {
  const trace: string[] = [];
  let reads = 0;
  const source = { get type() { trace.push("type"); return ++reads === 1 ? first : first === undefined ? "bytes" : undefined; } };
  const strategy = { get size() { trace.push("size"); return undefined; }, get highWaterMark() { trace.push("highWaterMark"); return 0; } };
  let error = "none";
  try { Reflect.construct(ReadableStream, [source, strategy]); }
  catch (reason) { error = reason instanceof Error ? reason.name : typeof reason; }
  return { changingType: String(first), trace, reads, error };
}
function captureDictionary<T extends typeof ReadableStream | typeof WritableStream | typeof TransformStream>(Ctor: T, entry: DictionaryCase, isProxy: (value: object) => boolean, active: () => boolean): T {
  return new Proxy(Ctor, { construct(target, args, newTarget) {
    if (!active()) return Reflect.construct(target, args, newTarget);
    if (entry.name !== "ReadableStream") return Reflect.construct(target, args, newTarget);
    const dictionary: object = args[0];
    dictionaryInvariant(!isProxy(dictionary), `${entry.name} received a Proxy dictionary`);
    dictionaryInvariant(Object.getPrototypeOf(dictionary) === Object.prototype, "dictionary is not ordinary");
    for (const key of entry.fields) dictionaryInvariant(typeof Object.getOwnPropertyDescriptor(dictionary, key)?.get === "function", `missing lazy own ${entry.name}.${key}`);
    const stream = Reflect.construct(target, args, newTarget);
    for (const key of entry.methods) checkOwnCallback(dictionary, entry.name, key);
    return stream;
  } });
}
function checkOwnCallback(dictionary: object, name: DictionaryName, key: string) {
  const value: unknown = Reflect.get(dictionary, key);
  const descriptor = Object.getOwnPropertyDescriptor(dictionary, key);
  dictionaryInvariant(typeof value === "function" && descriptor?.value === value, `${name}.${key} is not an own callback data property`);
  dictionaryInvariant(Reflect.get(dictionary, key) === value, `${name}.${key} callback is not stable`);
}
export async function dictionaryRepresentation(install: () => () => void, isProxy: (value: object) => boolean = () => false) {
  let active = false;
  for (const entry of dictionaries) Reflect.set(globalThis, entry.name, captureDictionary(globalThis[entry.name], entry, isProxy, () => active));
  const dispose = install();
  active = true;
  try {
    for (const entry of dictionaries) await representationControl(entry);
    const bytes = new ReadableStream({ type: "bytes", start() {}, pull(controller) { controller.close(); }, cancel() {} }, { highWaterMark: 0 });
    dictionaryInvariant((await bytes.getReader().read()).done, "bytes EOF changed");
  } finally { dispose(); }
}
async function representationControl(entry: DictionaryCase) {
  const source = {};
  const trace: string[] = [];
  const callback = function (this: object) { dictionaryInvariant(this === source, "callback receiver changed"); };
  const properties = {};
  const get = (key: string) => function (this: object) {
    dictionaryInvariant(this === source, "representation getter receiver changed");
    trace.push(key);
    return callback;
  };
  for (const key of entry.methods) Object.defineProperty(properties, key, { get: get(key) });
  Object.setPrototypeOf(source, properties);
  Object.freeze(source);
  const stream = Reflect.construct(globalThis[entry.name], [source, { highWaterMark: 0 }]);
  if (entry.name === "ReadableStream") dictionaryInvariant(trace.length === entry.methods.length, "callback getter count changed");
  if (stream instanceof ReadableStream) await stream.cancel();
  else if (stream instanceof WritableStream) await stream.abort();
  else await stream.writable.abort();
}
