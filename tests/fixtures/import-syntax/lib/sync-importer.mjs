export const load = (specifier) => import(specifier);
export const nested = () => `${import("./value.mjs").then(m => m.value) instanceof Promise}`;
