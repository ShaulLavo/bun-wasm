// A module without top-level await that waited for one with it finishes
// evaluating when that dependency does. A later import graph that reaches it
// must not wait for it again (SvelteKit's second Vite config load did).
const first = await import("./first.mjs");
console.log("first", first.value);
const second = await import("./second.mjs");
console.log("second", second.value);
