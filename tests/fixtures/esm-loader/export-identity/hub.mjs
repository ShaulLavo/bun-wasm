// `x` reaches one binding through both stars; `y` reaches two bindings with equal values,
// so it is ambiguous; the explicit `shadowed` wins over both stars.
export * from './one.mjs';
export * from './two.mjs';
export const shadowed = 'hub';
