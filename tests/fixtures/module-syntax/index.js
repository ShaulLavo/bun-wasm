const nested = require('./nested.js');
const strings = require('./strings.js');
console.log(nested.value, strings);
const { value } = await import('./top-level.js');
console.log(value);
