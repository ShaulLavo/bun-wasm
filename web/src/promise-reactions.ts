type Reaction = (value: unknown) => unknown;
const NativePromise = Promise;
const then = NativePromise.prototype.then;
const apply = Reflect.apply;

export function observePromise(promise: Promise<unknown>, fulfilled?: Reaction, rejected?: Reaction): Promise<unknown> {
  return apply(then, promise, [fulfilled, rejected]);
}
