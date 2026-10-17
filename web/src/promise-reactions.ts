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
const speciesGetter = descriptor(NativePromise, species)?.get;
const speciesConstructor = Object.freeze({ [species]: NativePromise });

function safeSpecies(): boolean {
  const own = descriptor(NativePromise, species);
  if (!own) return false;
  if ("value" in own) return own.value == null || own.value === NativePromise;
  return own.get === undefined || own.get === speciesGetter;
}

function safeConstructor(own: PropertyDescriptor): boolean {
  if (!("value" in own)) return own.get === undefined;
  return own.value === undefined || (own.value === NativePromise && safeSpecies());
}

function safeLockedPromise(promise: Promise<unknown>, own: PropertyDescriptor | undefined): boolean {
  if (own) return safeConstructor(own);
  if (prototype(promise) !== promisePrototype) return false;
  const inherited = descriptor(promisePrototype, "constructor");
  return inherited !== undefined && safeConstructor(inherited);
}

export function observePromise(promise: Promise<unknown>, fulfilled?: Reaction, rejected?: Reaction): Promise<unknown> {
  const own = descriptor(promise, "constructor");
  const replaceable = own ? own.configurable || ("value" in own && own.writable) : extensible(promise);
  if (!replaceable) {
    if (safeLockedPromise(promise, own)) return apply(then, promise, [fulfilled, rejected]);
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
