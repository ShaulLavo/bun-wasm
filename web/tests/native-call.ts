/** The host ABI mixes byte, text and integer results; validate the named slot before calling. */
export function nativeCall(natives: Record<string, (...args: never[]) => unknown>, name: string, ...args: unknown[]): unknown {
  const slot = natives[name];
  if (!slot) throw new Error(`Missing native slot ${name}`);
  return Reflect.apply(slot, null, args);
}
