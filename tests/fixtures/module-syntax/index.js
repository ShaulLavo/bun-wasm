const nested = require('./nested.js');
const strings = require('./strings.js');
console.log(nested.value, strings);
await import('./top-level.js');
