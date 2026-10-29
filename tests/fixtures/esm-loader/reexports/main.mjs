import { renamed, shared, onlyX, onlyY, nsX, def } from './hub.mjs';
import * as hub from './hub.mjs';
console.log(renamed, onlyX, onlyY, nsX.onlyX, def(), shared);
console.log(Object.keys(hub).join(','));
console.log('ambiguous hidden', 'clash' in hub, 'default' in hub);
