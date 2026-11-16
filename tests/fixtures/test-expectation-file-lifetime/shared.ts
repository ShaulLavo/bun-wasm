import { expect } from "bun:test";
let cached: ReturnType<typeof expect> | undefined;
let promised: ReturnType<typeof expect> | undefined;
export function shared() { return cached ??= expect(1); }
export function sharedPromise() { return promised ??= expect(Promise.resolve(1)); }

let rejected: ReturnType<typeof expect> | undefined;
export function sharedRejection() { return rejected ??= expect(Promise.reject(1)); }
