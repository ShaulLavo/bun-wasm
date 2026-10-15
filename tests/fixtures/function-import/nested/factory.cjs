exports.load = new Function('specifier', 'return import(specifier)');
exports.call = Function('specifier', 'return import(specifier)');
exports.indirect = (function () {}).constructor('specifier', 'return import(specifier)');
exports.asyncLoad = Object.getPrototypeOf(async function () {}).constructor('specifier', 'return await import(specifier)');
exports.generator = Object.getPrototypeOf(function* () {}).constructor('specifier', 'yield import(specifier)');
exports.asyncGenerator = Object.getPrototypeOf(async function* () {}).constructor('specifier', 'yield await import(specifier)');
exports.make = function make() { return new Function('specifier', 'return import(specifier)'); };
