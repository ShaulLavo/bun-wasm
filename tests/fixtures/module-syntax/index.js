const nested = require('./nested.js');
const strings = require('./strings.js');
const requireMain = require('./require-main.js');
console.log(nested.value, strings);
console.log(requireMain.value, requireMain.main);
await import('./top-level.js');
