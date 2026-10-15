const path = require('node:path');
console.log('require-meta', path.basename(import.meta.path));
