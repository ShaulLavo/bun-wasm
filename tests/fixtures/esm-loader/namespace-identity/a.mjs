import * as self from './a.mjs';
globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;
export let v = 0;
export function inc() { v++; }
globalThis.inside = self;
