(function (internal: BunWasm.Internal) {
  "use strict";
  const { native } = internal;
  const NativePromise = Promise;
  const NativeTypeError = TypeError;
  const { ownKeys, getOwnPropertyDescriptor, get } = Reflect;
  const apply = Reflect.apply;
  const then = Promise.prototype.then;
  const resolved = Promise.resolve.bind(Promise);

  function object(value: unknown): value is object {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  function mode(options: unknown): BunWasm.ImportMode {
    if (options === undefined) return "inferred";
    if (!object(options)) throw new NativeTypeError("Import options must be an object");
    const attributes: unknown = get(options, "with");
    if (attributes === undefined) return "inferred";
    if (!object(attributes)) throw new NativeTypeError("Import attributes must be an object");
    const entries: [string, unknown][] = [];
    const names = ownKeys(attributes);
    for (let index = 0; index < names.length; index++) {
      const key = names[index];
      if (typeof key !== "string" || !getOwnPropertyDescriptor(attributes, key)?.enumerable) continue;
      entries[entries.length] = [key, get(attributes, key)];
    }
    let selected: BunWasm.ImportMode = "inferred";
    for (let index = 0; index < entries.length; index++) {
      const key = entries[index][0];
      const value = entries[index][1];
      if (typeof value !== "string") throw new NativeTypeError("Import attribute values must be strings");
      if (key === "type" && value === "text") selected = "text";
    }
    return selected;
  }

  function run<T>(load: BunWasm.ImportJob<T>, text: string, selected: BunWasm.ImportMode,
    resolve: (value: T) => void, reject: (error: unknown) => void): void {
    try { load(text, selected, resolve, reject); } catch (error) { reject(error); }
  }

  const imports: BunWasm.ImportRequests = {
    request<T>(specifier: unknown, options: unknown, load: BunWasm.ImportJob<T>): Promise<T> {
      return new NativePromise<T>((resolve, reject) => {
        try {
          const text = `${specifier}`;
          const selected = mode(options);
          apply(then, resolved(), [() => run(load, text, selected, resolve, reject), reject]);
        } catch (error) { reject(error); }
      });
    },
    resolve: (specifier, referrer, selected) => native.resolveImport(specifier, referrer, selected),
  };
  internal.importRequests = imports;
  const initialize = globalThis.__bunwasm_initializeImportRequests;
  if (initialize !== undefined) initialize(imports);
  delete globalThis.__bunwasm_initializeImportRequests;
  internal.defineGlobal("__bunwasm_importRequests", imports);
  if (native.engine === "host") return imports;
  internal.defineGlobal("__bunwasm_dynamicImport", (from: string) => (specifier: unknown, options?: unknown) =>
    imports.request(specifier, options, (text, selected, resolve, reject) => {
      const name = imports.resolve(text, from, selected);
      apply(then, native.importModule(name), [resolve, reject]);
    }));
  return imports;
})
