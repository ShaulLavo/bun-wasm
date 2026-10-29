import './sibling.mjs';
import { never } from './failing.mjs';
console.log('main must not run', never);
