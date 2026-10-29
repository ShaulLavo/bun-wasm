export let count = 0;
export function increment() { count += 1; }
export function reset() { count = 0; }
export { count as alias };
