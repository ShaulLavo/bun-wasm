export type CallEvent = { stage: "entry" | "return" | "throw" | "resolve" | "reject"; value?: unknown };

function notify(observe: (event: CallEvent) => void, event: CallEvent): void {
  try { observe(event); } catch {}
}

export function observeCall<Method extends Function>(method: Method, observe: (event: CallEvent) => void): Method {
  return new Proxy(method, {
    apply(target, receiver, args) {
      notify(observe, { stage: "entry" });
      let result: unknown;
      try { result = Reflect.apply(target, receiver, args); }
      catch (error) { notify(observe, { stage: "throw", value: error }); throw error; }
      notify(observe, { stage: "return", value: result });
      observeSettlement(result, observe);
      return result;
    },
  });
}

function observeSettlement(result: unknown, observe: (event: CallEvent) => void): void {
  // Side observation adds reactions and marks the original handled. Neither handler returns the observed value.
  try {
    if (!isSafeNativePromise(result)) return;
    Promise.prototype.then.call(result,
      (value: unknown) => { notify(observe, { stage: "resolve", value }); },
      (value: unknown) => { notify(observe, { stage: "reject", value }); });
  } catch {}
}

const nativeSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species);

function hasSafeNativeSpecies(): boolean {
  const current = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
  if (!nativeSpecies) return !current;
  return current?.get === nativeSpecies.get && current?.set === nativeSpecies.set;
}

function hasSafeConstructorValue(descriptor: PropertyDescriptor): boolean {
  if (!("value" in descriptor)) return false;
  return descriptor.value === undefined || descriptor.value === null || descriptor.value === Promise;
}

function isSafeNativePromise(value: unknown): value is Promise<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  if (!hasSafeNativeSpecies()) return false;
  const seen = new Set<object>();
  let current: object | null = value;
  while (current !== null) {
    if (seen.has(current)) return false;
    seen.add(current);
    const constructor = Object.getOwnPropertyDescriptor(current, "constructor");
    if (constructor) return hasSafeConstructorValue(constructor);
    current = Object.getPrototypeOf(current);
  }
  return false;
}

export function replaceMethod(prototype: object, name: string, wrap: (original: Function) => Function): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return false;
  if (!descriptor.configurable && !descriptor.writable) return false;
  Object.defineProperty(prototype, name, { ...descriptor, value: wrap(descriptor.value) });
  return true;
}

export function shadowMethod(prototype: object, name: string, wrap: (original: Function) => Function): boolean {
  let owner: object | null = prototype;
  while (owner && !Object.hasOwn(owner, name)) owner = Object.getPrototypeOf(owner);
  if (!owner) return false;
  if (owner === prototype) return replaceMethod(prototype, name, wrap);
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return false;
  Object.defineProperty(prototype, name, { ...descriptor, configurable: true, value: wrap(descriptor.value) });
  return true;
}
