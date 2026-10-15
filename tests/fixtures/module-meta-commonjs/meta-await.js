const path = require('node:path');
async function probe() { await Promise.resolve(); }
console.log('await-meta', path.basename(import.meta.path));
probe();
