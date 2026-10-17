type Reaction = (value: unknown) => unknown;
const NativePromise = Promise;
const NativeTypeError = TypeError;
const promisePrototype = NativePromise.prototype;
const then = promisePrototype.then;
const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor;
const define = Object.defineProperty;
const remove = Reflect.deleteProperty;
const extensible = Object.isExtensible;
const prototype = Object.getPrototypeOf;
const species = Symbol.species;
const nativeSpeciesDescriptor = descriptor(NativePromise, species);
const nativeSpeciesGetter = nativeSpeciesDescriptor && "get" in nativeSpeciesDescriptor ? nativeSpeciesDescriptor.get : undefined;
const speciesConstructor = Object.freeze({ [species]: NativePromise });

type DescriptorLocation = { owner: object; descriptor: PropertyDescriptor };

function findDescriptor(value: object, key: PropertyKey): DescriptorLocation | undefined {
  const seen = new Set<object>();
  let current: object | null = value;
  while (current !== null) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const own = descriptor(current, key);
    if (own) return { owner: current, descriptor: own };
    current = prototype(current);
  }
  return undefined;
}

function safeNativeSpecies(): boolean {
  const found = findDescriptor(NativePromise, species);
  if (!found) return true;
  const own = found.descriptor;
  if ("value" in own) return own.value === undefined || own.value === null || own.value === NativePromise;
  if (own.get === undefined) return true;
  return found.owner === NativePromise && own.get === nativeSpeciesGetter && own.set === nativeSpeciesDescriptor?.set;
}

function safeSpeciesValue(value: unknown, constructor: object): boolean {
  if (value === undefined || value === null) return true;
  if (value === NativePromise) return safeNativeSpecies();
  if (typeof value !== "object" && typeof value !== "function") return false;
  const found = findDescriptor(value, species);
  if (!found) return true;
  const own = found.descriptor;
  if ("value" in own) return own.value === undefined || own.value === null || own.value === NativePromise;
  if (own.get !== undefined) return constructor === NativePromise && found.owner === NativePromise && own.get === nativeSpeciesGetter && own.set === nativeSpeciesDescriptor?.set;
  return true;
}

function safeConstructorDescriptor(found: DescriptorLocation): boolean {
  const own = found.descriptor;
  if (!('value' in own)) return own.get === undefined;
  return safeSpeciesValue(own.value, own.value as object);
}

function safePromiseShape(promise: Promise<unknown>, own: PropertyDescriptor | undefined): boolean {
  if (own) {
    const found = { owner: promise, descriptor: own } satisfies DescriptorLocation;
    return safeConstructorDescriptor(found);
  }
  const inherited = findDescriptor(promise, "constructor");
  if (!inherited) return true;
  return safeConstructorDescriptor(inherited);
}

export function observePromise(promise: Promise<unknown>, fulfilled?: Reaction, rejected?: Reaction): Promise<unknown> {
  const own = descriptor(promise, "constructor");
  // Proxy traps on a constructor or species holder are user code; a throwing one must not escape the matcher.
  let safe = false;
  try { safe = safePromiseShape(promise, own); } catch { safe = false; }
  if (safe) return apply(then, promise, [fulfilled, rejected]);
  const replaceable = own ? own.configurable || ("value" in own && own.writable) : extensible(promise);
  if (!replaceable) {
    const cause = own
      ? ("value" in own ? "read-only constructor with unsafe species" : "non-configurable constructor accessor")
      : "non-extensible promise with unsafe constructor or species";
    throw new NativeTypeError(`bun:test browser engine cannot observe this promise: ${cause}. An intrinsic reaction hook is required to mark its rejection handled.`);
  }
  try {
    if (own && !own.configurable) define(promise, "constructor", { value: speciesConstructor });
    else define(promise, "constructor", { value: speciesConstructor, configurable: true, writable: true });
    return apply(then, promise, [fulfilled, rejected]);
  } finally {
    if (own) define(promise, "constructor", own);
    else remove(promise, "constructor");
  }
}
