const globalThis = {};
module.exports = {
  load: (specifier, options) => import(specifier, options),
  shadowed: (globalThis, specifier, options) => import(specifier, options),
};
