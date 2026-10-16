const path = require('node:path');
const same: boolean = __dirname === import.meta.dir;
console.log('types-meta', same, path.basename(import.meta.path));
